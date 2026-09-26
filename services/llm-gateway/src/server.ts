import pg from 'pg'
import { createGateway } from './gateway.js'
import { GatewayLedger } from './ledger.js'
import { loadPolicy } from './policy.js'

/**
 * llm-gateway entrypoint: loads and verifies
 * the signed policy (or refuses to start), opens the ledger as the gateway
 * role, and serves the Messages API with guards. The only container with
 * provider egress.
 */
const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, msg, ...extra, at: new Date().toISOString() }))

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    log('fatal', `${name} is not set`)
    process.exit(1)
  }
  return value
}

const PORT = Number(process.env.GATEWAY_PORT ?? 8787)
let loaded
try {
  loaded = loadPolicy(required('GATEWAY_POLICY_PATH'), required('GATEWAY_POLICY_PUBLIC_KEY'))
} catch (error) {
  log('fatal', 'policy rejected', { error: (error as Error).message })
  process.exit(1)
}
const databaseUrl = process.env.GATEWAY_DATABASE_URL
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 4 }) : null
if (!pool) log('warn', 'no GATEWAY_DATABASE_URL: ledger and honeytoken lookups are disabled')
// An idle pooled client can fail asynchronously, outside any query: Postgres sends SQLSTATE 57P01
// ("terminating connection due to administrator command") to every connection when it restarts.
// node-pg surfaces that on the pool's emitter; with no listener Node throws it as an unhandled
// 'error' event and the process dies. The gateway is on the critical answer path, so it reports the
// error and stays up, letting the pool reconnect on the next query: policy enforcement and egress
// control must keep serving even while the ledger is briefly unreachable, and a failed ledger read
// is already handled in the request path. It never self-exits on a DB blip.
pool?.on('error', (error: Error & { code?: string }) => {
  log('error', 'idle pool client error', { code: error.code, error: error.message })
})

const foundryBase = process.env.FOUNDRY_BASE_URL
const server = createGateway({
  policy: loaded.policy,
  policyHash: loaded.hash,
  ledger: new GatewayLedger(pool, required('HONEYTOKEN_HMAC_KEY')),
  // The compliance canary is keyed by the same secret under its own domain, so there
  // is one key to manage and neither kind of token can be replayed as the other.
  canaryKey: required('HONEYTOKEN_HMAC_KEY'),
  routes: {
    anthropic: {
      baseUrl: process.env.UPSTREAM_BASE_URL ?? 'https://api.anthropic.com',
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    },
    foundry: foundryBase ? { baseUrl: foundryBase, token: foundryToken } : undefined,
  },
  onEvent: (event, fields) =>
    log(
      event === 'policy.enforced' || event === 'honeytoken.foreign' ? 'warn' : 'info',
      event,
      fields
    ),
})

/** Managed identity on Azure; a static token only when explicitly configured for tests. */
async function foundryToken(): Promise<string> {
  const fixed = process.env.FOUNDRY_STATIC_TOKEN
  if (fixed) return fixed
  const { DefaultAzureCredential } = await import('@azure/identity')
  const token = await new DefaultAzureCredential().getToken(
    'https://cognitiveservices.azure.com/.default'
  )
  return token.token
}

server.listen(PORT, '0.0.0.0', () =>
  log('info', 'llm-gateway listening', { port: PORT, policyVersion: loaded.policy.version })
)
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => server.close(() => process.exit(0)))
