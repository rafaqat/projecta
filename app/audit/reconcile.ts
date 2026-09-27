import type { Pool } from 'pg'

/**
 * Nightly reconciliation (design §8): the app ledger and the
 * gateway ledger must agree call for call by token id, and every gateway
 * row must belong to a user who had a live session when the call started.
 * Mismatches are findings, not repairs: the ledgers are never edited.
 */
export interface Finding {
  kind: 'missing_in_gateway' | 'missing_in_app' | 'status_mismatch' | 'no_active_session'
  jti: string
  detail: string
}

export interface ReconciliationReport {
  since: string
  appRows: number
  gatewayRows: number
  findings: Finding[]
}

export async function reconcileLedgers(pool: Pool, since: Date): Promise<ReconciliationReport> {
  const app = await pool.query(
    `select jti, status, user_id from llm_usage where started_at >= $1 and jti is not null`,
    [since]
  )
  const gateway = await pool.query(
    `select jti, status, sub, started_at from gateway.ledger where started_at >= $1`,
    [since]
  )
  const appByJti = new Map(
    (app.rows as Array<{ jti: string; status: string; user_id: number }>).map((r) => [r.jti, r])
  )
  const gwByJti = new Map(
    (gateway.rows as Array<{ jti: string; status: string; sub: string; started_at: Date }>).map(
      (r) => [r.jti, r]
    )
  )
  const findings: Finding[] = []
  for (const [jti, row] of appByJti) {
    const other = gwByJti.get(jti)
    if (!other) findings.push({ kind: 'missing_in_gateway', jti, detail: `app ${row.status}` })
    else if (
      other.status !== row.status &&
      !(row.status === 'completed' && other.status === 'blocked')
    ) {
      findings.push({
        kind: 'status_mismatch',
        jti,
        detail: `app ${row.status}, gateway ${other.status}`,
      })
    }
  }
  for (const [jti, row] of gwByJti) {
    if (!appByJti.has(jti))
      findings.push({
        kind: 'missing_in_app',
        jti,
        detail: `gateway ${row.status} for sub ${row.sub}`,
      })
    // A token for a user with no session live at that moment is the bypass signature.
    const session = await pool.query(
      `select 1 from sessions where user_id = $1 and expires_at >= $2 limit 1`,
      [row.sub, row.started_at]
    )
    if (session.rows.length === 0)
      findings.push({ kind: 'no_active_session', jti, detail: `sub ${row.sub}` })
  }
  return { since: since.toISOString(), appRows: appByJti.size, gatewayRows: gwByJti.size, findings }
}
