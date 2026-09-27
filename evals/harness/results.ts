import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TARGETS } from './metrics.ts'
import type { LoadedTier } from './load.ts'
import type { MetricResult, Tier, TierReport } from './types.ts'

const here = dirname(fileURLToPath(import.meta.url))
const RUNS = join(here, '..', 'runs')

/** What a slice's measurement writes: one number per metric key, for one tier. */
interface TierResults {
  generatedAt: string
  metrics: Record<string, number>
}

/**
 * Reads a tier's measured results from evals/runs/<tier>.latest.json. Tier-AGNOSTIC on purpose: the
 * substrate names no tier. A missing/unreadable file leaves every metric red — the "present and red
 * from the start" baseline slice 0 ships. Each later slice greens its tier by dropping in a
 * measurement that writes this file (robustness → slice 2, correctness → slice 3, adversarial →
 * slice 4). The measured numbers are the oracle; they come from that separate run, never from
 * calling the code being graded.
 */
async function readTierResults(tier: Tier): Promise<Record<string, number> | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(RUNS, `${tier}.latest.json`), 'utf8')
    ) as TierResults
    return parsed?.metrics ?? null
  } catch {
    return null
  }
}

/** Fills a tier's metric `actual`s from its results file; unmeasured metrics stay null (red). */
export async function measureTier(loaded: LoadedTier): Promise<TierReport> {
  const measured = await readTierResults(loaded.tier)
  const metrics: MetricResult[] = TARGETS[loaded.tier].map((m) => {
    const actual = measured?.[m.key] ?? null
    const met = actual !== null && (m.direction === 'ge' ? actual >= m.target : actual <= m.target)
    return { key: m.key, label: m.label, target: m.target, direction: m.direction, actual, met }
  })
  return {
    tier: loaded.tier,
    cases: loaded.cases.length,
    labelled: loaded.labelled.length,
    pending: loaded.pending.length,
    metrics,
  }
}
