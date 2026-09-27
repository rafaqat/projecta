import type { IngestProgress } from '#app/ingest/pipeline'

/**
 * A stall is a failure. On 2026-09-20 an ingest lost its database connection under a
 * test suite's load and then made no progress for three hours and fifty-six minutes with the job
 * `active`: no error, only a promise that never settled. The watchdog turns silence into a coded
 * failure the worker's existing path records and pg-boss retries.
 */
export const DEFAULT_STALL_MS = 20 * 60_000

export class IngestStalledError extends Error {
  readonly code = 'E_INGEST_STALLED'
  constructor(
    readonly stallMs: number,
    readonly lastProgress: IngestProgress | null
  ) {
    super(
      `ingest reported no progress for ${stallMs} ms` +
        (lastProgress
          ? ` (last: ${lastProgress.phase} ${lastProgress.done}/${lastProgress.total})`
          : ' (no progress reported)')
    )
  }
}

export interface WatchdogOptions {
  /** Silence this long fails the run. */
  stallMs?: number
  /** The clock; injectable so a test can drive it. */
  now?: () => number
  /** How often the clock is consulted. */
  pollMs?: number
}

export type WatchedRun<T> = Promise<T> & { report: (progress: IngestProgress) => void }

/**
 * Runs `run` and rejects with `IngestStalledError` if no `report` arrives within `stallMs`. The
 * abandoned run is not cancelled — its child processes are bounded by their own timeouts — but
 * the job is failed, recorded and retried instead of held until its lease expires.
 */
export function withStallWatchdog<T>(
  run: () => Promise<T>,
  options: WatchdogOptions = {}
): WatchedRun<T> {
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS
  const now = options.now ?? Date.now
  const pollMs = options.pollMs ?? Math.min(stallMs, 30_000)
  let lastAt = now()
  let lastProgress: IngestProgress | null = null
  const watched = new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setInterval(() => {
      if (settled) return
      if (now() - lastAt >= stallMs) {
        settled = true
        clearInterval(timer)
        reject(new IngestStalledError(stallMs, lastProgress))
      }
    }, pollMs)
    run().then(
      (value) => {
        if (settled) return
        settled = true
        clearInterval(timer)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearInterval(timer)
        reject(error)
      }
    )
  }) as WatchedRun<T>
  watched.report = (progress) => {
    lastAt = now()
    lastProgress = progress
  }
  return watched
}

/**
 * Serialised progress writes that never queue behind a dead one: a write that fails
 * is reported to `onError` — logged with its code and hash by the caller — and dropped, and the
 * next report starts a fresh write. The progress row is a courtesy to the reader; the step's
 * status row is the record, so a lost update is tolerable and a hung chain is not.
 */
export function progressChain<P>(
  write: (progress: P) => Promise<unknown>,
  onError: (error: unknown, progress: P) => void
): { report: (progress: P) => void; flush: () => Promise<void> } {
  let chain: Promise<void> = Promise.resolve()
  return {
    report(progress) {
      chain = chain
        .then(() => write(progress))
        .then(
          () => undefined,
          (error) => onError(error, progress)
        )
    },
    flush: () => chain,
  }
}
