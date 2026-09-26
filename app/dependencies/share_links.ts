import { createHash, randomBytes } from 'node:crypto'

/**
 * BOM share links (WP-23). A link is a bearer credential, so the token exists in exactly
 * two places: the creator's screen, once, and the URL they send. Everywhere else — both tables,
 * logs, audit events — it is its SHA-256.
 */

/** Fixed at acceptance by the owner (2026-09-19): a link is a hand-over, not a standing URL. */
export const SHARE_TTL_MS = 15 * 60 * 1000

export const SHARE_FORMATS = ['spdx', 'cyclonedx'] as const
export type ShareFormat = (typeof SHARE_FORMATS)[number]

/** 32 random bytes in base64url: 43 characters, no padding. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

export function newShareToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: sha256(token) }
}

/**
 * The hash a presented token is looked up by, or null for anything that cannot be a token — so a
 * malformed path never reaches the database, and an attacker's guess costs a lookup only when it
 * is at least shaped like one. Comparison happens in the database on the hash, which is fixed-length
 * and not the secret, so there is no timing signal about the token itself.
 */
export function shareTokenHash(presented: unknown): string | null {
  return typeof presented === 'string' && TOKEN.test(presented) ? sha256(presented) : null
}

export function isShareFormat(value: unknown): value is ShareFormat {
  return typeof value === 'string' && (SHARE_FORMATS as readonly string[]).includes(value)
}
