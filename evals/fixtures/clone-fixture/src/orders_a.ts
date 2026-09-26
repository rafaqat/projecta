// Type-1 twin of orders_b.ts::totalA (exact copy). FIXTURE-CANARY-clone-e5f3
export function totalA(items: Array<{ price: number; qty: number }>): number {
  let sum = 0
  for (const item of items) {
    sum += item.price * item.qty
  }
  return sum
}

// Type-3 near miss of refunds.ts::refundB: the divergence is the status check (seeded difference: 'paid' vs 'captured').
export function refundA(order: { status: string; amount: number }): number {
  if (order.status !== 'paid') throw new Error('not refundable')
  return order.amount
}
