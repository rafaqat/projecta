/**
 * Symbols named after ordinary English words. Every identifier here is
 * also a word a person uses in a question about something else.
 */
export type state = 'open' | 'closed'

export interface order {
  id: string
  key: string
  state: state
}

export function closure(value: number): () => number {
  return () => value
}

export function map<T, U>(items: T[], fn: (item: T) => U): U[] {
  return items.map(fn)
}

export function key(item: order): string {
  return item.key
}

export function index(items: order[]): Record<string, order> {
  const out: Record<string, order> = {}
  for (const item of items) out[item.id] = item
  return out
}

export function id(item: order): string {
  return item.id
}

export function request(path: string): { path: string } {
  return { path }
}

export function user(name: string): { name: string } {
  return { name }
}

export function format(value: number): string {
  return value.toFixed(2)
}

export function filter(items: order[], state: state): order[] {
  return items.filter((item) => item.state === state)
}

export function test(value: unknown): boolean {
  return value !== undefined
}
