/** A file committed with Windows line endings. */
export function totalWithTax(subtotal: number, rate: number): number {
  const tax = subtotal * rate
  return subtotal + tax
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}
