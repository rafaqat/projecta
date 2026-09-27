/**
 * Whether a commit's share of flagged chunks jumped against the previous commit of the same
 * repository. The count alone is not worth an alert: the detector's false-positive rate
 * was 0.153 over 176 clean spans (2026-09-18), so a level is mostly noise and grows with the
 * repository. A change is informative, because a constant false-positive rate cancels out of a
 * delta — the same reasoning as the gateway's `injection.suspected`, which alerts on a rate per
 * workspace and never on a total.
 *
 * This reports; it never gates. The flag stays annotation-only (proved by
 * tests/functional/benign/flag_ablation.spec.ts), and no alert here changes what is indexed,
 * retrieved or answered. Nor does its absence mean a repository is clean: recall is 0.405, and
 * the ranking attack of is not instruction-shaped at all, so it is never flagged.
 */
export interface FlaggedCounts {
  chunks: number
  flagged: number
}

/** Below this many chunks a share is not a measurement. */
export const MIN_CHUNKS = 20
/** A jump must also be this many chunks, so a tiny repository cannot raise one on rounding. */
export const MIN_NEW_FLAGS = 3
/** How much of the repository must newly carry instruction-shaped prose to be worth saying. */
export const RATE_JUMP = 0.1

export interface RateJump {
  previousRate: number
  rate: number
  flagged: number
  chunks: number
}

export function rateJump(previous: FlaggedCounts | null, current: FlaggedCounts): RateJump | null {
  if (!previous) return null
  if (current.chunks < MIN_CHUNKS || previous.chunks < MIN_CHUNKS) return null
  if (current.flagged - previous.flagged < MIN_NEW_FLAGS) return null
  const previousRate = previous.flagged / previous.chunks
  const rate = current.flagged / current.chunks
  if (rate - previousRate < RATE_JUMP) return null
  return { previousRate, rate, flagged: current.flagged, chunks: current.chunks }
}
