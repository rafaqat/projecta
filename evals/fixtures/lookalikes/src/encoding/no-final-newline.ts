/** A file whose last line has no newline. */
export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

export function between(value: number, low: number, high: number): boolean {
  return value >= low && value <= high
}