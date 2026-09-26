import { randomBytes } from 'node:crypto'

/**
 * Opaque handles for URLs. 80 random bits in Crockford base32:
 * unguessable, case-insensitive, and never a database ID or a SHA.
 */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
export const HANDLE_PATTERN = /^[0-9a-hjkmnp-tv-z]{16}$/

export function newHandle(): string {
  return Array.from(randomBytes(16), (byte) => ALPHABET[byte % 32]).join('')
}

export function isHandle(value: unknown): value is string {
  return typeof value === 'string' && HANDLE_PATTERN.test(value)
}
