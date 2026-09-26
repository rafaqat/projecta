import type { MetricResult, RunReport } from './types.ts'

function fmt(v: number | null): string {
  return v === null ? '—' : v.toFixed(3)
}

function statusOf(m: MetricResult): string {
  if (m.actual === null) return 'RED (no system under test)'
  return m.met ? 'met' : 'UNMET'
}

/** A human-readable table per tier: metric, target, actual, status. */
export function renderReport(report: RunReport): string {
  const lines: string[] = []
  lines.push(`eval report — ${report.generatedAt}`)
  for (const t of report.tiers) {
    lines.push('')
    lines.push(
      `## ${t.tier}  (${t.cases} cases · ${t.labelled} labelled · ${t.pending} pending label)`
    )
    lines.push(`   ${'metric'.padEnd(28)} ${'target'.padEnd(7)} ${'actual'.padEnd(7)} status`)
    for (const m of t.metrics) {
      const tgt = `${m.direction === 'ge' ? '>=' : '<='}${m.target}`
      lines.push(
        `   ${m.label.padEnd(28)} ${tgt.padEnd(7)} ${fmt(m.actual).padEnd(7)} ${statusOf(m)}`
      )
    }
  }
  return lines.join('\n')
}

export interface Ratchet {
  regressions: string[]
}

/**
 * The ratchet: a metric regresses if its actual drops below (ge) or rises above (le) the accepted
 * baseline. Null actuals (no measurement yet) never count as a regression, so an all-red baseline
 * lets early slices stay red without failing the run. Targets are reported separately as warnings.
 */
export function ratchet(report: RunReport, baseline: RunReport | null): Ratchet {
  const regressions: string[] = []
  if (!baseline) return { regressions }
  const base = new Map<string, number | null>()
  for (const t of baseline.tiers)
    for (const m of t.metrics) base.set(`${t.tier}.${m.key}`, m.actual)
  for (const t of report.tiers) {
    for (const m of t.metrics) {
      const key = `${t.tier}.${m.key}`
      const prior = base.get(key)
      if (prior === undefined || prior === null || m.actual === null) continue
      const worse = m.direction === 'ge' ? m.actual < prior : m.actual > prior
      if (worse) regressions.push(`${key}: ${m.actual} worse than baseline ${prior}`)
    }
  }
  return { regressions }
}
