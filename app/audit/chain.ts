import { createHash } from 'node:crypto'
import canonicalize from 'canonicalize'

/**
 * Per-workspace hash chain. Each event's hash covers the previous
 * hash and the event's RFC 8785 canonical JSON. Pure: shared by the
 * audit-writer service and `audit:verify`.
 */
export const GENESIS = '0'.repeat(64)

export interface ChainEvent {
  workspaceId: string
  seq: number
  event: string
  payload: unknown
  occurredAt: string
  prevHash: string
}

export function eventHash(event: ChainEvent): string {
  return createHash('sha256').update(canonicalize(event)!).digest('hex')
}

/** The material a batch signature covers: workspace, range and head. */
export function batchDigest(
  workspaceId: string,
  fromSeq: number,
  toSeq: number,
  headHash: string
): Buffer {
  return createHash('sha256').update(`${workspaceId}:${fromSeq}:${toSeq}:${headHash}`).digest()
}
