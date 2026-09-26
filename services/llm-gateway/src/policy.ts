import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import canonicalize from 'canonicalize'

/**
 * Signed gateway policy: the validated configuration set and the
 * guard settings, produced by the release workflow and verified here
 * against a pinned public key at load. Without a valid policy the gateway
 * does not start.
 */
export interface GatewayPolicy {
  version: number
  issuedAt: string
  models: string[]
  configHashes: string[]
  promptHashes: string[]
  toolDefinitionHashes: string[]
  blockTypes: string[]
  canaries: string[]
  allowedUrlHosts: string[]
  routes: { default: 'anthropic' | 'foundry'; workspaces: Record<string, 'anthropic' | 'foundry'> }
  attributionKeys: Record<string, { kty: string; crv: string; x: string }>
}

export class PolicyError extends Error {}

export function policyDigest(policy: GatewayPolicy): Buffer {
  return createHash('sha256').update(canonicalize(policy)!).digest()
}

export function verifyPolicy(policy: GatewayPolicy, signature: string, publicKey: KeyObject): void {
  let ok = false
  try {
    ok = verify(null, policyDigest(policy), publicKey, Buffer.from(signature, 'base64url'))
  } catch {
    ok = false
  }
  if (!ok) throw new PolicyError('policy signature does not verify against the pinned key')
}

export function loadPolicy(
  path: string,
  publicKeyJwk: string
): { policy: GatewayPolicy; hash: string } {
  const policy = JSON.parse(readFileSync(path, 'utf8')) as GatewayPolicy
  const signature = readFileSync(`${path}.sig`, 'utf8').trim()
  const key = createPublicKey({ key: JSON.parse(publicKeyJwk), format: 'jwk' })
  verifyPolicy(policy, signature, key)
  return { policy, hash: policyDigest(policy).toString('hex') }
}

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** The static system block hash and the tool-definition hash as the policy records them. */
export function promptHashOf(system: unknown): string | null {
  if (typeof system === 'string') return sha256(system)
  if (Array.isArray(system) && system[0]?.type === 'text') return sha256(String(system[0].text))
  return null
}

export function toolHashOf(tools: unknown): string {
  const stripped = ((tools as Array<{ name: string; input_schema: unknown }>) ?? []).map((t) => ({
    name: t.name,
    inputSchema: t.input_schema,
  }))
  return sha256(canonicalize(stripped)!)
}
