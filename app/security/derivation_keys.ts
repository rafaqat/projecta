import { createHmac } from 'node:crypto'
import env from '#start/env'

/**
 * Workspace-keyed derivations. Each workspace has its own HMAC key
 * derived from a master key, so derived artefacts (caches, secret
 * fingerprints) are never comparable across workspaces. On Azure the master
 * key lives in Key Vault; locally it falls back to APP_KEY.
 */
const SEPARATOR = String.fromCharCode(0)

function masterKey(): Buffer {
  const configured = process.env.DERIVATION_MASTER_KEY
  return Buffer.from(configured ?? env.get('APP_KEY').release(), 'utf8')
}

export function workspaceKey(workspaceId: string): Buffer {
  return createHmac('sha256', masterKey()).update(`workspace:${workspaceId}`).digest()
}

/** `HMAC(workspaceKey, parts joined by NUL)` as hex: the cache key shape from design §4. */
export function derivationKey(key: Buffer, ...parts: string[]): string {
  return createHmac('sha256', key).update(parts.join(SEPARATOR)).digest('hex')
}
