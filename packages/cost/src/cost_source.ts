import type { DailyTotal, Route } from './reconcile.js'

/**
 * The CostSource port (ADR-038): daily totals for a window from the billing
 * provider of one route. Adapters live in services/cost-reconciler with the
 * credential; nothing in app/** or the gateway imports them.
 */
export interface Window {
  /** Inclusive ISO date, UTC. */
  from: string
  /** Inclusive ISO date, UTC. */
  to: string
}

export interface CostSource {
  readonly route: Route
  readonly environment: string
  dailyTotals(window: Window): Promise<DailyTotal[]>
}

export type { DailyTotal, Route }

/** Sorted by day, then model, so reports and fixtures compare byte for byte. */
export function sortTotals(totals: DailyTotal[]): DailyTotal[] {
  return [...totals].sort(
    (a, b) =>
      a.day.localeCompare(b.day) || a.model.localeCompare(b.model) || a.route.localeCompare(b.route)
  )
}

/** Merges rows of the same (day, route, environment, model), summing cost. */
export function mergeTotals(rows: DailyTotal[]): DailyTotal[] {
  const merged = new Map<string, DailyTotal>()
  for (const r of rows) {
    const key = `${r.day}|${r.route}|${r.environment}|${r.model}`
    const seen = merged.get(key)
    if (seen) seen.costUsd = Math.round((seen.costUsd + r.costUsd) * 1e6) / 1e6
    else merged.set(key, { ...r })
  }
  return sortTotals([...merged.values()])
}
