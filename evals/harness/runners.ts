import { measureTier } from './results.ts'
import type { LoadedTier } from './load.ts'
import type { TierReport } from './types.ts'

/**
 * Runs one tier. The substrate carries no per-tier logic: it reads whatever measurement that tier's
 * slice published to evals/runs/<tier>.latest.json (via measureTier) and reports it. With no file,
 * every metric is null → red — the all-red baseline slice 0 ships. Each slice greens its own tier by
 * adding a measurement that writes its results file; by slice 5 every file exists → all green.
 */
export async function runTier(loaded: LoadedTier): Promise<TierReport> {
  return measureTier(loaded)
}
