import { readFileSync } from 'node:fs'
import app from '@adonisjs/core/services/app'
import { MODELS } from '#app/llm/client'
import { inScope, type Scope } from '#app/security/scope'
import { costOf, loadPriceTable, type PriceTable, type Route } from '#cost/prices'

/**
 * What a turn cost and what the next one is likely to (UAT 2026-09-15).
 * Cost is derived, never stored: the turn's ledger rows (llm_usage, one per
 * model call) times the versioned price table, so every figure
 * names the price version it was derived with. The estimate for the next
 * question is the median of the reader's recent turns in the workspace or,
 * before any, the budgets' shape: the system prompt and the evidence window
 * in, the output cap out.
 */
export interface TurnCost {
  usd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  calls: number
  priceVersion: string
}

export interface CostEstimate {
  usd: number
  basis: 'recent' | 'budget'
  priceVersion: string
}

let table: PriceTable | undefined
export function priceTable(): PriceTable {
  table ??= loadPriceTable(
    JSON.parse(
      readFileSync(process.env.COST_PRICES_PATH ?? app.makePath('config/prices.json'), 'utf8')
    )
  )
  return table
}

/** The route the gateway bills this environment on; Foundry once WP-14 points it there. */
export function costRoute(): Route {
  return (process.env.COST_ROUTE as Route | undefined) ?? 'anthropic'
}

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }

/** Every model call of every turn handle, summed per turn; a turn without ledger rows has no cost yet. */
export async function turnCosts(
  scope: Scope,
  turnHandles: string[]
): Promise<Map<string, TurnCost>> {
  if (turnHandles.length === 0) return new Map()
  const rows = await inScope(scope, (trx) =>
    trx
      .from('llm_usage')
      .where('workspace_id', scope.workspaceId!)
      .whereIn('turn_handle', turnHandles)
      .select(
        'turn_handle',
        'model',
        'input_tokens',
        'output_tokens',
        'cache_read_tokens',
        'cache_creation_tokens'
      )
  )
  const prices = priceTable()
  const out = new Map<string, TurnCost>()
  for (const row of rows) {
    const usage = {
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      cacheReadTokens: Number(row.cache_read_tokens ?? 0),
      cacheCreationTokens: Number(row.cache_creation_tokens ?? 0),
    }
    const cost = out.get(String(row.turn_handle)) ?? {
      usd: 0,
      ...ZERO,
      calls: 0,
      priceVersion: prices.version,
    }
    cost.usd += costOf(prices, costRoute(), String(row.model), usage)
    cost.inputTokens += usage.inputTokens
    cost.outputTokens += usage.outputTokens
    cost.cacheReadTokens += usage.cacheReadTokens
    cost.cacheCreationTokens += usage.cacheCreationTokens
    cost.calls += 1
    out.set(String(row.turn_handle), cost)
  }
  return out
}

/** Tokens the budgets imply for one turn before any has run: the prompt and evidence in, the output cap out. */
const BUDGET_SHAPE = {
  inputTokens: 9_000,
  outputTokens: 700,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
}

export async function estimateNextTurn(scope: Scope, recent = 20): Promise<CostEstimate> {
  const prices = priceTable()
  const handles = await inScope(scope, (trx) =>
    trx
      .from('llm_usage')
      .where({ workspace_id: scope.workspaceId!, user_id: scope.userId, purpose: 'answer' })
      .whereNotNull('turn_handle')
      .groupBy('turn_handle')
      .select('turn_handle')
      .max('started_at as last')
      .orderBy('last', 'desc')
      .limit(recent)
  )
  const costs = await turnCosts(
    scope,
    handles.map((h) => String(h.turn_handle))
  )
  const sorted = [...costs.values()].map((c) => c.usd).sort((x, y) => x - y)
  if (sorted.length >= 3)
    return {
      usd: sorted[Math.floor(sorted.length / 2)],
      basis: 'recent',
      priceVersion: prices.version,
    }
  return {
    usd: costOf(prices, costRoute(), MODELS.answer, BUDGET_SHAPE),
    basis: 'budget',
    priceVersion: prices.version,
  }
}
