import { mergeTotals, type DailyTotal, type Window } from './cost_source.js'
import { costOf, type PriceTable, type Route } from './prices.js'

/**
 * The internal leg (ADR-038): the application ledger's tokens per day, route
 * and model, priced with the versioned table. The route is the gateway
 * ledger's for the same call (joined by token id); a call with no gateway
 * row is priced on the direct route and counted as such, so a bypass shows
 * up as a variance instead of vanishing.
 */
export interface LedgerQuery {
  (sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>>
}

export interface LedgerTotals {
  totals: DailyTotal[]
  /** Calls with no gateway row: reconciliation by request id (ADR-024) owns these; listed so the variance is explained. */
  unmatchedCalls: number
  priceVersion: string
}

export async function ledgerTotals(
  query: LedgerQuery,
  window: Window,
  environment: string,
  prices: PriceTable
): Promise<LedgerTotals> {
  const rows = await query(
    `select to_char(u.started_at at time zone 'UTC', 'YYYY-MM-DD') as day,
            u.model,
            coalesce(g.route, 'anthropic') as route,
            (g.jti is null)::int as unmatched,
            sum(u.input_tokens)::bigint as input_tokens,
            sum(u.output_tokens)::bigint as output_tokens,
            sum(u.cache_read_tokens)::bigint as cache_read_tokens,
            sum(u.cache_creation_tokens)::bigint as cache_creation_tokens,
            count(*)::int as calls
       from llm_usage u
       left join gateway.ledger g on g.jti = u.jti
      where u.started_at >= $1::date and u.started_at < ($2::date + interval '1 day')
        and u.status = 'completed'
      group by 1, 2, 3, 4
      order by 1, 2, 3`,
    [window.from, window.to]
  )
  const totals: DailyTotal[] = []
  let unmatchedCalls = 0
  for (const r of rows) {
    const route = String(r.route) as Route
    if (Number(r.unmatched) === 1) unmatchedCalls += Number(r.calls)
    totals.push({
      day: String(r.day),
      route,
      environment,
      model: String(r.model),
      costUsd: costOf(prices, route, String(r.model), {
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        cacheReadTokens: Number(r.cache_read_tokens),
        cacheCreationTokens: Number(r.cache_creation_tokens),
      }),
    })
  }
  return { totals: mergeTotals(totals), unmatchedCalls, priceVersion: prices.version }
}
