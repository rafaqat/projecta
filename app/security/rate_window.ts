/**
 * A sliding-window rate limit keyed by string, for the one unauthenticated route that serves
 * tenant data. In process memory: each web replica counts on its own, so the effective
 * limit is per replica — a bound on abuse, not an accounting. No dependency is approved for this
 * (R-10), and a route this narrow does not need one.
 */
export class RateWindow {
  private readonly hits = new Map<string, number[]>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Records a hit and says whether it is within the limit. */
  allow(key: string): boolean {
    const t = this.now()
    const recent = (this.hits.get(key) ?? []).filter((at) => t - at < this.windowMs)
    const allowed = recent.length < this.limit
    if (allowed) recent.push(t)
    this.hits.set(key, recent)
    // Keys that went quiet are dropped, so a scan of random tokens cannot grow the map for ever.
    if (this.hits.size > 10_000) {
      for (const [key2, times] of this.hits)
        if (!times.some((at) => t - at < this.windowMs)) this.hits.delete(key2)
    }
    return allowed
  }
}
