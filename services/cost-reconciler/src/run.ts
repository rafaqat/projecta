import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CostSource, Window } from '../../../packages/cost/src/cost_source.js'
import { ledgerTotals, type LedgerQuery } from '../../../packages/cost/src/ledger_totals.js'
import type { PriceTable } from '../../../packages/cost/src/prices.js'
import {
  reconcileCosts,
  type CostReport,
  type Drift,
  type Tolerance,
} from '../../../packages/cost/src/reconcile.js'

/**
 * One reconciliation run: the priced application ledger against
 * every configured provider source, the report written as a file and every
 * breach emitted as `cost.reconciliation_drift`. Never a chained event and
 * never an input to a request-path decision.
 */
export interface DriftEvent {
  event: 'cost.reconciliation_drift'
  day: string
  route: string
  dimension: string
  varianceUsd: number
}

export interface RunOptions {
  query: LedgerQuery
  prices: PriceTable
  environment: string
  sources: CostSource[]
  window: Window
  tolerance: Tolerance
  revisionLagDays: number
  today: Date
  reportPath: string
  emit: (event: DriftEvent) => void
}

export interface WrittenReport extends CostReport {
  at: string
  environment: string
  window: Window
  priceVersion: string
  unmatchedCalls: number
  routes: string[]
}

export async function runReconciliation(options: RunOptions): Promise<WrittenReport> {
  const internal = await ledgerTotals(
    options.query,
    options.window,
    options.environment,
    options.prices
  )
  const perSource = await Promise.all(options.sources.map((s) => s.dailyTotals(options.window)))
  const provider = perSource.flat()
  const routes = new Set(options.sources.map((s) => s.route))
  const report = reconcileCosts({
    // Only routes with a configured source are compared; the others would read as total drift.
    internal: internal.totals.filter((t) => routes.has(t.route)),
    provider,
    tolerance: options.tolerance,
    revisionLagDays: options.revisionLagDays,
    today: options.today,
  })
  for (const d of report.drift) options.emit(toEvent(d))
  const written: WrittenReport = {
    at: options.today.toISOString(),
    environment: options.environment,
    window: options.window,
    priceVersion: internal.priceVersion,
    unmatchedCalls: internal.unmatchedCalls,
    routes: [...routes].sort(),
    ...report,
  }
  await mkdir(dirname(options.reportPath), { recursive: true })
  await writeFile(options.reportPath, JSON.stringify(written, null, 2) + '\n')
  return written
}

function toEvent(d: Drift): DriftEvent {
  return {
    event: 'cost.reconciliation_drift',
    day: d.day,
    route: d.route,
    dimension: d.dimension,
    varianceUsd: d.varianceUsd,
  }
}
