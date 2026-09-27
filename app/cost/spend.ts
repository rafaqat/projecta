import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { costOf } from '#cost/prices'
import { costRoute, priceTable } from '#app/cost/turn_cost'

/**
 * Attributed spend from the cost ledger (WP-25): what the priced `llm_usage` rows say a
 * person or a workspace spent over a window — accounting for spend, which is what attributing
 * every token to a person was built for.
 *
 * Deliberately narrow. It reads the ledger, never telemetry (keeps user and workspace out
 * of metrics). It reports money and tokens and nothing framed as output, throughput or rank. It is
 * attributed spend, not the invoice: the reconciler (WP-20) remains the accounting truth.
 */
export interface LedgerRow {
  userId: number
  model: string
  purpose: string
  startedAt: Date
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface SpendLine {
  usd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  calls: number
}

export interface SpendBreakdown extends SpendLine {
  /** The UTC day, `YYYY-MM-DD`. */
  day: string
  model: string
  purpose: string
}

export type Pricer = (model: string, usage: Omit<SpendLine, 'usd' | 'calls'>) => number

const empty = (): SpendLine => ({
  usd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  calls: 0,
})

function add(line: SpendLine, row: LedgerRow, usd: number) {
  line.usd += usd
  line.inputTokens += row.inputTokens
  line.outputTokens += row.outputTokens
  line.cacheReadTokens += row.cacheReadTokens
  line.cacheCreationTokens += row.cacheCreationTokens
  line.calls += 1
}

/** Pure: rows and a pricer in, totals, per-user lines and the (day, model, purpose) breakdown out. */
export function aggregateSpend(
  rows: LedgerRow[],
  price: Pricer
): { totals: SpendLine; byUser: Map<number, SpendLine>; breakdown: SpendBreakdown[] } {
  const totals = empty()
  const byUser = new Map<number, SpendLine>()
  const byKey = new Map<string, SpendBreakdown>()
  for (const row of rows) {
    const usd = price(row.model, row)
    const day = row.startedAt.toISOString().slice(0, 10)
    add(totals, row, usd)
    if (!byUser.has(row.userId)) byUser.set(row.userId, empty())
    add(byUser.get(row.userId)!, row, usd)
    const key = JSON.stringify([day, row.model, row.purpose])
    if (!byKey.has(key)) byKey.set(key, { day, model: row.model, purpose: row.purpose, ...empty() })
    add(byKey.get(key)!, row, usd)
  }
  const breakdown = [...byKey.values()].sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      a.model.localeCompare(b.model) ||
      a.purpose.localeCompare(b.purpose)
  )
  return { totals, byUser, breakdown }
}

/** The price the answer card uses: one table, one route, so a turn and a report agree. */
export const ledgerPrice: Pricer = (model, usage) => costOf(priceTable(), costRoute(), model, usage)

/**
 * The workspace's ledger rows since `from`, optionally one user's. Runs inside the caller's tenant
 * scope — `llm_usage` is under forced row-level security (INV-09), so no other workspace's rows can
 * be read here whatever the query says.
 */
export async function ledgerRows(
  trx: TransactionClientContract,
  workspaceId: string,
  from: Date,
  userId?: number
): Promise<LedgerRow[]> {
  const query = trx
    .from('llm_usage')
    .where('workspace_id', workspaceId)
    .where('started_at', '>=', from)
    .select(
      'user_id',
      'model',
      'purpose',
      'started_at',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_creation_tokens'
    )
  if (userId !== undefined) query.where('user_id', userId)
  const rows = await query
  return rows.map((r) => ({
    userId: Number(r.user_id),
    model: String(r.model),
    purpose: String(r.purpose),
    startedAt: new Date(r.started_at),
    inputTokens: Number(r.input_tokens ?? 0),
    outputTokens: Number(r.output_tokens ?? 0),
    cacheReadTokens: Number(r.cache_read_tokens ?? 0),
    cacheCreationTokens: Number(r.cache_creation_tokens ?? 0),
  }))
}
