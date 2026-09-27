/** Structurally identical, semantically different. */
export function addAll(values: number[]): number {
  let total = 0
  for (const value of values) {
    total = total + value
  }
  return total
}

export function subtractAll(values: number[]): number {
  let total = 0
  for (const value of values) {
    total = total - value
  }
  return total
}

/** Two comparisons that differ by one token; only one of them is a bug. */
export function isOverLimit(amount: number, limit: number): boolean {
  return amount > limit
}

export function isAtOrOverLimit(amount: number, limit: number): boolean {
  return amount >= limit
}
