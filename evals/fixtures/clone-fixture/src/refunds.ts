export function refundB(order: { status: string; amount: number }): number {
  if (order.status !== 'captured') throw new Error('not refundable')
  return order.amount
}

// Boilerplate hard negatives: repeated pattern, not a duplicate.
export function isEmptyA(xs: unknown[]): boolean {
  return xs.length === 0
}
export function isEmptyB(ys: unknown[]): boolean {
  return ys.length === 0
}
