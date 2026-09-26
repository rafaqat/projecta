import { createHash, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { gzipSync } from 'node:zlib'
import type { AddressInfo } from 'node:net'
import canonicalize from 'canonicalize'
import { SignJWT } from 'jose'
import { GatewayLedger } from '../../../services/llm-gateway/src/ledger.js'
import { createGateway, type GatewayOptions } from '../../../services/llm-gateway/src/gateway.js'
import {
  policyDigest,
  promptHashOf,
  toolHashOf,
  type GatewayPolicy,
} from '../../../services/llm-gateway/src/policy.js'

/**
 * Conformance harness (design §10): a recording provider that replays a
 * fixture stream and captures the request it received, a signed policy for
 * a canonical request, and a gateway bound to both on ephemeral ports.
 */
export interface Recorded {
  url: string
  headers: Record<string, string>
  body: string
}

export function recordingProvider(
  fixture: string,
  options: { status?: number; delayMs?: number; gzip?: boolean; append?: string } = {}
) {
  const recorded: Recorded[] = []
  const stream = fixture ? readFileSync(`tests/fixtures/provider/${fixture}`, 'utf8') : ''
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    recorded.push({
      url: req.url ?? '',
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
      body: Buffer.concat(chunks).toString('utf8'),
    })
    if (options.gzip) {
      // The real provider compresses streams; the gateway must not forward that header over decoded bytes.
      res.writeHead(options.status ?? 200, {
        'content-type': 'text/event-stream',
        'content-encoding': 'gzip',
      })
      res.end(gzipSync(stream))
      return
    }
    res.writeHead(options.status ?? 200, { 'content-type': 'text/event-stream' })
    // Frames are sent one at a time so hold-back sees delta boundaries as the provider produces them.
    for (const frame of stream.split('\n\n').filter(Boolean)) {
      res.write(frame + '\n\n')
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs))
    }
    // `append` puts a frame after the recorded stream, for testing what a client tolerates.
    if (options.append) res.write(options.append)
    res.end()
  })
  return { server, recorded, listen: () => listen(server) }
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

export const CANARY = 'SYSTEM-CANARY-1f3b'
export const SYSTEM = `You answer questions about one repository. ${CANARY}`
export const TOOLS = [
  {
    name: 'search_code',
    description: 'Search',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
]
export const CONFIG_HASH = 'c'.repeat(64)

export function canonicalBody(extra: Record<string, unknown> = {}) {
  return {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    stream: true,
    system: [{ type: 'text', text: SYSTEM }],
    tools: TOOLS,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'search_result',
            source: 'r1',
            title: 'src/services/PaymentService.ts',
            content: [{ type: 'text', text: 'async refundPayment(paymentIntentId: string) {' }],
            citations: { enabled: true },
          },
          { type: 'text', text: 'How is a refund processed?' },
        ],
      },
    ],
    ...extra,
  }
}

export interface Keys {
  policy: KeyObject
  web: KeyObject
  worker: KeyObject
}

export function keys(): Keys {
  const gen = () => generateKeyPairSync('ed25519').privateKey
  return { policy: gen(), web: gen(), worker: gen() }
}

const jwkOf = (key: KeyObject) =>
  createPublicKey(key).export({ format: 'jwk' }) as { kty: string; crv: string; x: string }

export function policyFor(k: Keys, overrides: Partial<GatewayPolicy> = {}): GatewayPolicy {
  return {
    version: 1,
    issuedAt: '2026-09-12T00:00:00Z',
    models: ['claude-haiku-4-5-20251001'],
    configHashes: [CONFIG_HASH],
    promptHashes: [promptHashOf([{ type: 'text', text: SYSTEM }])!],
    toolDefinitionHashes: [toolHashOf(TOOLS)],
    blockTypes: ['text', 'search_result', 'tool_use', 'tool_result'],
    canaries: [CANARY],
    allowedUrlHosts: ['github.com'],
    routes: { default: 'anthropic', workspaces: {} },
    attributionKeys: { web: jwkOf(k.web), worker: jwkOf(k.worker) },
    ...overrides,
  }
}

export function signPolicy(policy: GatewayPolicy, key: KeyObject): string {
  return sign(null, policyDigest(policy), key).toString('base64url')
}

export async function token(
  k: Keys,
  body: unknown,
  claims: Partial<{
    sub: string
    workspace: string
    purpose: string
    aud: string
    exp: string
    jti: string
    signer: 'web' | 'worker'
    reqSha256: string
  }> = {}
) {
  const reqSha256 =
    claims.reqSha256 ?? createHash('sha256').update(canonicalize(body)!).digest('hex')
  const signer = claims.signer ?? 'web'
  return new SignJWT({
    workspace: claims.workspace ?? 'ws-a',
    purpose: claims.purpose ?? 'answer',
    req_sha256: reqSha256,
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: signer })
    .setSubject(claims.sub ?? '1')
    .setAudience(claims.aud ?? 'llm-gateway')
    .setJti(claims.jti ?? crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(claims.exp ?? '120s')
    .sign(k[signer])
}

export interface Started {
  url: string
  events: Array<{ event: string; fields: Record<string, unknown> }>
  close: () => Promise<void>
}

export async function startGateway(
  policy: GatewayPolicy,
  upstreamUrl: string,
  options: Partial<GatewayOptions> & {
    honeytokens?: Record<string, string>
    /** The deployed lookup (a query on `gateway.honeytoken_hmacs`), for a test that spans the app and the gateway. */
    honeytokenOwner?: (candidate: string) => Promise<{ workspaceId: string } | null>
    foundry?: { baseUrl: string; token: string }
  } = {}
): Promise<Started> {
  const events: Started['events'] = []
  const hmacKey = 'test-honeytoken-key'
  const ledger = new GatewayLedger(null, hmacKey)
  // In-memory honeytoken HMAC table for the conformance suite: hmac → workspace.
  const table = new Map(
    Object.entries(options.honeytokens ?? {}).map(([tokenValue, ws]) => [
      ledger.hmac(tokenValue),
      ws,
    ])
  )
  ledger.honeytokenOwner =
    options.honeytokenOwner ??
    (async (candidate) => {
      const ws = table.get(ledger.hmac(candidate))
      return ws ? { workspaceId: ws } : null
    })
  // The harness's own options never reach createGateway; the rest are the gateway's.
  const gatewayOptions: Partial<GatewayOptions> = { ...options }
  delete (gatewayOptions as Record<string, unknown>).honeytokens
  delete (gatewayOptions as Record<string, unknown>).honeytokenOwner
  delete (gatewayOptions as Record<string, unknown>).foundry
  const server = createGateway({
    policy,
    policyHash: policyDigest(policy).toString('hex'),
    ledger,
    routes: {
      anthropic: { baseUrl: upstreamUrl, apiKey: 'provider-key-1234' },
      foundry: options.foundry
        ? { baseUrl: options.foundry.baseUrl, token: async () => options.foundry!.token }
        : undefined,
    },
    onEvent: (event, fields) => events.push({ event, fields }),
    ...gatewayOptions,
  })
  const url = await listen(server)
  return { url, events, close: () => new Promise((r) => server.close(() => r())) }
}

export async function call(gw: Started, body: unknown, headers: Record<string, string>) {
  const response = await fetch(`${gw.url}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-config-hash': CONFIG_HASH,
      ...headers,
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, text: await response.text(), headers: response.headers }
}

export { jwkOf }
