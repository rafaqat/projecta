// Lint fixture: a decision-record path that hashes the question directly.
import { createHash } from 'node:crypto'

export function fingerprint(question: string): string {
  return createHash('sha256').update(question).digest('hex')
}
