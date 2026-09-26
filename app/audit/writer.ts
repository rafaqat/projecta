import { randomUUID, type KeyObject } from 'node:crypto'
import type { Pool } from 'pg'
import type { AnchorStore } from './anchors.js'
import { GENESIS, batchDigest, eventHash } from './chain.js'
import { keyId, publicKeyOf, signDigest } from './signing.js'

/**
 * The audit writer: consumes audit_outbox in batches, assigns
 * per-workspace sequence numbers, extends the hash chain, signs each batch
 * and appends to audit_events with database-clock timestamps. Anchors chain
 * heads to write-once storage every `anchorEvery` events or
 * `anchorIntervalMs`, and immediately after a security-relevant event.
 * Plain pg and node:crypto only: shared by the service and the tests.
 */
export const SECURITY_RELEVANT = new Set([
  'policy.enforced',
  'decision.flagged',
  'deployment.completed',
  'redteam.completed',
  'release.evidence_published',
  // Tenant data leaving without a session: anchored at once, not at the next interval.
  'bom_share.created',
  'bom_share.revoked',
  'bom_share.fetched',
  'audit_trail.reviewed',
])

export interface WriterOptions {
  key: KeyObject
  anchors: AnchorStore
  batchSize?: number
  anchorEvery?: number
  anchorIntervalMs?: number
  now?: () => Date
}

interface OutboxRow {
  id: string
  workspace_id: string
  event: string
  payload: unknown
  created_at: Date
}

export class AuditWriter {
  private readonly sinceAnchor = new Map<
    string,
    { events: number; at: number; security: boolean }
  >()
  private readonly kid: string

  constructor(
    private readonly pool: Pool,
    private readonly options: WriterOptions
  ) {
    this.kid = keyId(publicKeyOf(options.key))
  }

  /** One consumption round: at most `batchSize` outbox rows, grouped per workspace. */
  async consumeOnce(): Promise<{ events: number; anchored: string[] }> {
    const client = await this.pool.connect()
    let events = 0
    try {
      await client.query('begin')
      const { rows } = await client.query<OutboxRow>(
        `select id, workspace_id, event, payload, created_at from audit_outbox
          order by id limit $1 for update skip locked`,
        [this.options.batchSize ?? 500]
      )
      const byWorkspace = new Map<string, OutboxRow[]>()
      for (const row of rows)
        byWorkspace.set(row.workspace_id, [...(byWorkspace.get(row.workspace_id) ?? []), row])
      for (const [workspaceId, batch] of byWorkspace) {
        const head = await client.query<{ seq: string; hash: string }>(
          `select seq, hash from audit_events where workspace_id = $1 order by seq desc limit 1`,
          [workspaceId]
        )
        let seq = head.rows[0] ? Number(head.rows[0].seq) : 0
        let prevHash = head.rows[0]?.hash ?? GENESIS
        const fromSeq = seq + 1
        const batchId = randomUUID()
        let security = false
        for (const row of batch) {
          seq++
          const clock = await client.query<{ now: Date }>('select clock_timestamp() as now')
          const occurredAt = clock.rows[0].now.toISOString()
          const hash = eventHash({
            workspaceId,
            seq,
            event: row.event,
            payload: row.payload,
            occurredAt,
            prevHash,
          })
          await client.query(
            `insert into audit_events (workspace_id, seq, event, payload, occurred_at, prev_hash, hash, batch_id)
             values ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              workspaceId,
              seq,
              row.event,
              JSON.stringify(row.payload),
              occurredAt,
              prevHash,
              hash,
              batchId,
            ]
          )
          prevHash = hash
          events++
          if (SECURITY_RELEVANT.has(row.event)) security = true
        }
        await client.query(
          `insert into audit_batches (id, workspace_id, from_seq, to_seq, head_hash, signature, key_id, written_at)
           values ($1, $2, $3, $4, $5, $6, $7, clock_timestamp())`,
          [
            batchId,
            workspaceId,
            fromSeq,
            seq,
            prevHash,
            signDigest(this.options.key, batchDigest(workspaceId, fromSeq, seq, prevHash)),
            this.kid,
          ]
        )
        const state = this.sinceAnchor.get(workspaceId) ?? {
          events: 0,
          at: this.now(),
          security: false,
        }
        state.events += batch.length
        state.security ||= security
        this.sinceAnchor.set(workspaceId, state)
      }
      if (rows.length)
        await client.query(`delete from audit_outbox where id = any($1::bigint[])`, [
          rows.map((r) => r.id),
        ])
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
    const anchored = await this.anchorDue()
    return { events, anchored }
  }

  /** Anchors every workspace whose head is due; `force` anchors all with unanchored events. */
  async anchorDue(force = false): Promise<string[]> {
    const anchored: string[] = []
    const every = this.options.anchorEvery ?? 500
    const interval = this.options.anchorIntervalMs ?? 5 * 60_000
    for (const [workspaceId, state] of this.sinceAnchor) {
      if (state.events === 0) continue
      const due =
        force || state.security || state.events >= every || this.now() - state.at >= interval
      if (!due) continue
      const head = await this.pool.query<{ seq: string; hash: string }>(
        `select seq, hash from audit_events where workspace_id = $1 order by seq desc limit 1`,
        [workspaceId]
      )
      if (!head.rows[0]) continue
      const seq = Number(head.rows[0].seq)
      const anchor = {
        workspaceId,
        seq,
        headHash: head.rows[0].hash,
        anchoredAt: new Date(this.now()).toISOString(),
        keyId: this.kid,
        signature: signDigest(
          this.options.key,
          batchDigest(workspaceId, 0, seq, head.rows[0].hash)
        ),
      }
      const location = await this.options.anchors.put(anchor)
      await this.pool.query(
        `insert into audit_anchors (id, workspace_id, seq, head_hash, location, anchored_at) values ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), workspaceId, seq, anchor.headHash, location, anchor.anchoredAt]
      )
      this.sinceAnchor.set(workspaceId, { events: 0, at: this.now(), security: false })
      anchored.push(workspaceId)
    }
    return anchored
  }

  private now(): number {
    return (this.options.now?.() ?? new Date()).getTime()
  }
}
