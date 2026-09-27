import type { Route } from './prices.js'

export type { Route }

/**
 * The third reconciliation leg (ADR-038): daily totals from the billing
 * provider against the two internal ledgers. Tolerance, not equality; days
 * inside the provider's revision window are provisional and never settled.
 */
export interface DailyTotal {
  /** ISO date, UTC. */
  day: string
  route: Route
  environment: string
  model: string
  costUsd: number
}

export interface Tolerance {
  absoluteUsd: number
  relative: number
}

export interface Comparison {
  day: string
  route: Route
  environment: string
  dimension: string
  internalUsd: number
  providerUsd: number
  varianceUsd: number
  status: 'within' | 'drift' | 'provisional'
}

export type Drift = Omit<Comparison, 'status'>

export interface CostReport {
  /** The last day old enough to be settled (today minus the revision lag). */
  settledThrough: string
  settled: Comparison[]
  provisional: Comparison[]
  drift: Drift[]
}

export interface ReconcileInput {
  internal: DailyTotal[]
  provider: DailyTotal[]
  tolerance: Tolerance
  revisionLagDays: number
  today: Date
}

const keyOf = (t: DailyTotal) => `${t.day}|${t.route}|${t.environment}|${t.model}`

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function reconcileCosts(input: ReconcileInput): CostReport {
  const settledThrough = isoDay(
    new Date(input.today.getTime() - input.revisionLagDays * 86_400_000)
  )
  const internal = new Map(input.internal.map((t) => [keyOf(t), t]))
  const provider = new Map(input.provider.map((t) => [keyOf(t), t]))
  const keys = [...new Set([...internal.keys(), ...provider.keys()])].sort()
  const settled: Comparison[] = []
  const provisional: Comparison[] = []
  const drift: Drift[] = []
  for (const key of keys) {
    const sample = internal.get(key) ?? provider.get(key)!
    const internalUsd = internal.get(key)?.costUsd ?? 0
    const providerUsd = provider.get(key)?.costUsd ?? 0
    const varianceUsd = round(providerUsd - internalUsd)
    const base: Omit<Comparison, 'status'> = {
      day: sample.day,
      route: sample.route,
      environment: sample.environment,
      dimension: sample.model,
      internalUsd,
      providerUsd,
      varianceUsd,
    }
    if (sample.day > settledThrough) {
      provisional.push({ ...base, status: 'provisional' })
      continue
    }
    const within =
      Math.abs(varianceUsd) <= input.tolerance.absoluteUsd ||
      Math.abs(varianceUsd) <= input.tolerance.relative * Math.max(internalUsd, providerUsd)
    settled.push({ ...base, status: within ? 'within' : 'drift' })
    if (!within) drift.push(base)
  }
  return { settledThrough, settled, provisional, drift }
}

/** Cents are the provider's precision; sub-cent noise is not drift. */
function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6
}
