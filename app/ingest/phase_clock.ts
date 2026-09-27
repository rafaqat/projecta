/**
 * Where a run spent its time, phase by phase.
 *
 * `ingest_steps` times whole steps, but `index` contains parsing, embedding and writing together,
 * so which of them dominates could only be guessed at. This accumulates wall-clock milliseconds per
 * phase and the totals are recorded with the step's result, where a reader can see them.
 *
 * Wall clock, not CPU: phases are run one after another, and a phase that waits on a model server
 * should show that wait. Overlapping phases would double-count, so they are timed one at a time.
 */
export interface PhaseClock {
  /** Runs `work`, attributing its elapsed time to `phase`. Repeated phases accumulate. */
  time<T>(phase: string, work: () => Promise<T>): Promise<T>
  /** Milliseconds per phase, in the order the phases first ran. */
  totals(): Record<string, number>
}

export function newPhaseClock(now: () => number = () => Date.now()): PhaseClock {
  const totals = new Map<string, number>()
  return {
    async time(phase, work) {
      const started = now()
      try {
        return await work()
      } finally {
        // In `finally`: a phase that threw still spent the time, and a run that failed slowly is
        // exactly the case a reader needs the breakdown for.
        totals.set(phase, (totals.get(phase) ?? 0) + (now() - started))
      }
    },
    totals() {
      return Object.fromEntries(totals)
    },
  }
}
