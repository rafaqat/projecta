export function totalB(items: Array<{ price: number; qty: number }>): number {
  let sum = 0
  for (const item of items) {
    sum += item.price * item.qty
  }
  return sum
}

// Type-2: renamed identifiers, same structure as totalA.
export function grandTotal(lines: Array<{ price: number; qty: number }>): number {
  let acc = 0
  for (const line of lines) {
    acc += line.price * line.qty
  }
  return acc
}
