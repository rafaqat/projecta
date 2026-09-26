import type { KeyObject } from 'node:crypto'
import type { Pool } from 'pg'
import type { AnchorStore } from './anchors.js'
import { GENESIS, batchDigest, eventHash } from './chain.js'
import { verifyDigest } from './signing.js'

/**
 * Chain verification: recomputes every hash, checks the linkage,
 * the batch signatures and, against the anchor store, that no event after
 * the last anchor has been removed. Read-only; runs in CI as audit:verify.
 */
export interface WorkspaceVerdict {
  workspaceId: string
  events: number
  ok: boolean
  problems: string[]
}

export async function verifyChains(
  pool: Pool,
  publicKey: KeyObject,
  anchors: AnchorStore
): Promise<WorkspaceVerdict[]> {
  const workspaces = await pool.query<{ workspace_id: string }>(
    `select distinct workspace_id from audit_events`
  )
  const verdicts: WorkspaceVerdict[] = []
  for (const { workspace_id: workspaceId } of workspaces.rows) {
    const problems: string[] = []
    const { rows } = await pool.query<{
      seq: string
      event: string
      payload: unknown
      occurred_at: Date
      prev_hash: string
      hash: string
    }>(
      `select seq, event, payload, occurred_at, prev_hash, hash from audit_events where workspace_id = $1 order by seq`,
      [workspaceId]
    )
    let prevHash = GENESIS
    let expectedSeq = 1
    const hashes = new Map<number, string>()
    for (const row of rows) {
      const seq = Number(row.seq)
      if (seq !== expectedSeq) problems.push(`gap: expected seq ${expectedSeq}, found ${seq}`)
      if (row.prev_hash !== prevHash) problems.push(`link broken at seq ${seq}`)
      const recomputed = eventHash({
        workspaceId,
        seq,
        event: row.event,
        payload: row.payload,
        occurredAt: row.occurred_at.toISOString(),
        prevHash: row.prev_hash,
      })
      if (recomputed !== row.hash) problems.push(`modified event at seq ${seq}`)
      hashes.set(seq, row.hash)
      prevHash = row.hash
      expectedSeq = seq + 1
    }
    const batches = await pool.query<{
      from_seq: string
      to_seq: string
      head_hash: string
      signature: string
    }>(
      `select from_seq, to_seq, head_hash, signature from audit_batches where workspace_id = $1 order by from_seq`,
      [workspaceId]
    )
    for (const b of batches.rows) {
      const to = Number(b.to_seq)
      if (hashes.get(to) !== b.head_hash) problems.push(`batch ${b.from_seq}-${to}: head mismatch`)
      if (
        !verifyDigest(
          publicKey,
          batchDigest(workspaceId, Number(b.from_seq), to, b.head_hash),
          b.signature
        )
      ) {
        problems.push(`batch ${b.from_seq}-${to}: bad signature`)
      }
    }
    const anchor = await anchors.latest(workspaceId)
    if (anchor) {
      if (
        !verifyDigest(
          publicKey,
          batchDigest(workspaceId, 0, anchor.seq, anchor.headHash),
          anchor.signature
        )
      ) {
        problems.push(`anchor at seq ${anchor.seq}: bad signature`)
      }
      if (hashes.get(anchor.seq) !== anchor.headHash) {
        problems.push(
          rows.length < anchor.seq
            ? `truncated: anchor covers seq ${anchor.seq}, chain has ${rows.length}`
            : `anchor at seq ${anchor.seq}: head mismatch`
        )
      }
    }
    verdicts.push({ workspaceId, events: rows.length, ok: problems.length === 0, problems })
  }
  return verdicts
}
