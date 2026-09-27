/**
 * The peak resident memory of this process over a span of work (: the worker was killed at
 * 12 GB mid-ingest, so the value at the end says nothing). Sampled on a timer and once more at
 * stop, so a peak still held when the work ends is always counted. It measures this process only:
 * parser child processes are not included — the embedder, which ran in process when the worker
 * was killed, is.
 */
export function watchPeakRss(
  intervalMs = 250,
  /** Where a reading comes from; injectable so the peak logic can be tested deterministically. */
  read: () => number = () => process.memoryUsage().rss
): { stop(): number } {
  let peak = read()
  let running = true
  const timer = setInterval(() => {
    peak = Math.max(peak, read())
  }, intervalMs)
  // A sampler must never be what keeps a process alive.
  timer.unref()
  return {
    stop() {
      if (running) {
        clearInterval(timer)
        peak = Math.max(peak, read())
        running = false
      }
      return peak
    },
  }
}
