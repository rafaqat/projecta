import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The compliance canary's token (ADR-069): the app mints one per sampled turn, and the gateway
 * recognises it without being told about it.
 *
 * `HTI-<nonce>-<mac>`, where the mac is an HMAC of the nonce under the key both sides hold. The
 * gateway recomputes it, so nothing is written per turn and no table has to be kept — unlike the
 * tenancy honeytoken, whose HMACs are stored because its tokens live in the index for the life of
 * a workspace. It also means a string of this shape in a repository does not verify, so quoting
 * one cannot block an answer.
 *
 * The key is the honeytoken key under a different domain, so there is one secret to manage and
 * neither kind of token can be replayed as the other.
 */
export const CANARY_IN_TEXT = /HTI-[0-9a-f]{8}-[0-9a-f]{16}/g
const DOMAIN = 'compliance-canary:'

const macOf = (nonce: string, key: string) =>
  createHmac('sha256', key).update(`${DOMAIN}${nonce}`).digest('hex').slice(0, 16)

/** A token for one turn. */
export function mintCanary(key: string): string {
  const nonce = randomBytes(4).toString('hex')
  return `HTI-${nonce}-${macOf(nonce, key)}`
}

/** Every token-shaped string in the text; whether each is ours is `verifyCanary`. */
export function canaryCandidates(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(CANARY_IN_TEXT), (m) => m[0])))
}

/** True only for a token this key minted: a look-alike in a repository is not one. */
export function verifyCanary(token: string, key: string): boolean {
  const match = /^HTI-([0-9a-f]{8})-([0-9a-f]{16})$/.exec(token)
  if (!match) return false
  const expected = Buffer.from(macOf(match[1], key), 'utf8')
  const given = Buffer.from(match[2], 'utf8')
  return expected.length === given.length && timingSafeEqual(expected, given)
}
