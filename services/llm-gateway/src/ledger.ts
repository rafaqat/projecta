import { createHmac, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

/**
 * The gateway's independent ledger (design §8): one row per call
 * in the gateway schema, written by the gateway role, which the app cannot
 * alter. Honeytoken lookups use the same connection: the table holds HMACs
 * only, never plaintext tokens (SEC-30).
 */
export interface LedgerRow {
  jti: string
  sub: string
  workspace: string
  purpose: string
  model: string
  route: string
  signer: string
}

export class GatewayLedger {
  constructor(
    private readonly pool: Pool | null,
    private readonly honeytokenKey: string
  ) {}

  async open(row: LedgerRow): Promise<string> {
    const id = randomUUID()
    await this.pool?.query(
      `insert into gateway.ledger (id, jti, sub, workspace_id, purpose, model, route, signer, status, started_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'running', clock_timestamp())`,
      [id, row.jti, row.sub, row.workspace, row.purpose, row.model, row.route, row.signer]
    )
    return id
  }

  async close(
    id: string,
    status: 'completed' | 'cancelled' | 'failed' | 'blocked',
    usage: { input?: number; output?: number } = {},
    rule?: string
  ) {
    await this.pool?.query(
      `update gateway.ledger set status = $2, input_tokens = $3, output_tokens = $4, rule = $5, ended_at = clock_timestamp() where id = $1`,
      [id, status, usage.input ?? null, usage.output ?? null, rule ?? null]
    )
  }

  hmac(token: string): string {
    return createHmac('sha256', this.honeytokenKey).update(token).digest('hex')
  }

  /** The workspace that planted a token, by HMAC; null when unknown. */
  async honeytokenOwner(candidate: string): Promise<{ workspaceId: string } | null> {
    if (!this.pool) return null
    const { rows } = await this.pool.query<{ workspace_id: string }>(
      `select workspace_id from gateway.honeytoken_hmacs where hmac = $1`,
      [this.hmac(candidate)]
    )
    return rows[0] ? { workspaceId: rows[0].workspace_id } : null
  }
}
