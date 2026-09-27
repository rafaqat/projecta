/**
 * Versioned price table with a route dimension (design §8, ADR-038). Cost
 * is derived from ledger tokens and this table, never stored: a price change
 * is a new version, and every figure names the version it was derived with.
 */
export type Route = 'anthropic' | 'foundry'

export interface UnitPrice {
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion: number
  cacheCreationPerMillion: number
}

export interface PriceTable {
  version: string
  routes: Record<Route, Record<string, UnitPrice>>
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

const COMPONENTS: Array<keyof UnitPrice> = [
  'inputPerMillion',
  'outputPerMillion',
  'cacheReadPerMillion',
  'cacheCreationPerMillion',
]

/** Parses a table, dropping annotation keys and refusing malformed prices. */
export function loadPriceTable(raw: unknown): PriceTable {
  const doc = raw as { version?: unknown; routes?: Record<string, Record<string, unknown>> }
  if (typeof doc.version !== 'string' || !doc.routes)
    throw new Error('price table: version and routes are required')
  const routes = { anthropic: {}, foundry: {} } as PriceTable['routes']
  for (const route of ['anthropic', 'foundry'] as Route[]) {
    for (const [model, price] of Object.entries(doc.routes[route] ?? {})) {
      const p = price as Record<string, unknown>
      for (const c of COMPONENTS)
        if (typeof p[c] !== 'number' || p[c] < 0)
          throw new Error(`price table: ${route}/${model}.${c} must be a non-negative number`)
      routes[route][model] = Object.fromEntries(
        COMPONENTS.map((c) => [c, p[c] as number])
      ) as unknown as UnitPrice
    }
  }
  return { version: doc.version, routes }
}

export function unitPrice(table: PriceTable, route: Route, model: string): UnitPrice {
  const price = table.routes[route]?.[model]
  if (!price)
    throw new Error(`no price for ${model} on the ${route} route (table ${table.version})`)
  return price
}

/** USD for one call or one day's tokens on a route. */
export function costOf(table: PriceTable, route: Route, model: string, usage: TokenUsage): number {
  const p = unitPrice(table, route, model)
  return (
    (usage.inputTokens * p.inputPerMillion +
      usage.outputTokens * p.outputPerMillion +
      usage.cacheReadTokens * p.cacheReadPerMillion +
      usage.cacheCreationTokens * p.cacheCreationPerMillion) /
    1_000_000
  )
}
