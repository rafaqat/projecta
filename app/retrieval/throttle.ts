/**
 * Per-user classifier throttle: after N out-of-scope decisions
 * within the window, stage 2 is skipped for the rest of it and such
 * questions get the out-of-scope template. In-memory per web node; the
 * decision record (WP-07) is the durable trail.
 */
export class ScopeThrottle {
  private readonly decisions = new Map<number, number[]>()
  private readonly notified = new Set<number>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now()
  ) {}

  recordOutOfScope(userId: number): void {
    const t = this.now()
    const list = (this.decisions.get(userId) ?? []).filter((ts) => t - ts < this.windowMs)
    list.push(t)
    this.decisions.set(userId, list)
  }

  isThrottled(userId: number): boolean {
    const t = this.now()
    const list = (this.decisions.get(userId) ?? []).filter((ts) => t - ts < this.windowMs)
    this.decisions.set(userId, list)
    const throttled = list.length >= this.limit
    if (!throttled) this.notified.delete(userId)
    return throttled
  }

  /** Seconds until the oldest counted decision leaves the window; 0 when not throttled. */
  retryAfterSeconds(userId: number): number {
    const list = this.decisions.get(userId) ?? []
    if (list.length < this.limit) return 0
    const oldest = list[list.length - this.limit]
    return Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000))
  }

  /** True the first time a user is found throttled in a window, so the event is recorded once. */
  firstThrottle(userId: number): boolean {
    if (this.notified.has(userId)) return false
    this.notified.add(userId)
    return true
  }
}
