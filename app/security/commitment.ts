import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Keyed commitments for erasable text. `HMAC(salt, content)` with
 * a random per-message salt stored beside the content; records and ledgers
 * hold only the commitment. Erasure deletes content and salt together, after
 * which nothing can verify the commitment. This is the only module that may
 * hash thread content (lint rule).
 */
export interface Commitment {
  salt: string
  commitment: string
}

export function commit(content: string, salt = randomBytes(32).toString('hex')): Commitment {
  return {
    salt,
    commitment: createHmac('sha256', Buffer.from(salt, 'hex')).update(content).digest('hex'),
  }
}

export function verifyCommitment(
  salt: string | null,
  content: string | null,
  commitment: string
): boolean {
  if (!salt || content === null) return false
  const actual = Buffer.from(commit(content, salt).commitment, 'hex')
  const expected = Buffer.from(commitment, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
