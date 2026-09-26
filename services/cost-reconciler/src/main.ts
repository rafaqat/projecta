import { readFileSync } from 'node:fs'
import pg from 'pg'
import type { CostSource } from '../../../packages/cost/src/cost_source.js'
import { loadPriceTable } from '../../../packages/cost/src/prices.js'
import { AnthropicAdminCostSource } from './anthropic_admin.js'
import { AzureCostManagementCostSource } from './azure_cost.js'
import { runReconciliation } from './run.js'

/**
 * cost-reconciler: the only process holding the provider Admin key
 * or the Cost Management reader identity, and the only holder of the
 * cost_reconciler database role (read-only on both ledgers). Runs once per
 * interval, writes the report file, emits drift as structured log events.
 * Starts and idles with no provider source configured; refuses to start
 * with an inference credential in its environment.
 */
const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, msg, ...extra, at: new Date().toISOString() }))

const databaseUrl = process.env.COST_RECONCILER_DATABASE_URL
if (!databaseUrl) {
  log('error', 'COST_RECONCILER_DATABASE_URL is required')
  process.exit(1)
}
if (process.env.ANTHROPIC_API_KEY) {
  log('error', 'an inference credential is present; the reconciler must never hold one')
  process.exit(1)
}

const environment = process.env.COST_ENVIRONMENT ?? 'local'
const prices = loadPriceTable(
  JSON.parse(readFileSync(process.env.COST_PRICES_PATH ?? 'config/prices.json', 'utf8'))
)
const sources: CostSource[] = []
if (process.env.ANTHROPIC_ADMIN_KEY && process.env.ANTHROPIC_WORKSPACE_ID) {
  sources.push(
    new AnthropicAdminCostSource({
      fetch,
      adminKey: process.env.ANTHROPIC_ADMIN_KEY,
      workspaceId: process.env.ANTHROPIC_WORKSPACE_ID,
      environment,
      baseUrl: process.env.ANTHROPIC_ADMIN_BASE_URL,
    })
  )
}
if (process.env.AZURE_COST_SCOPE && process.env.AZURE_COST_DEPLOYMENTS) {
  // The bearer comes from managed identity in WP-14; until then an explicit token for rehearsals.
  const token = process.env.AZURE_COST_TOKEN
  if (!token) log('warn', 'AZURE_COST_SCOPE set without a token source; the Foundry leg is skipped')
  else
    sources.push(
      new AzureCostManagementCostSource({
        fetch,
        token: async () => token,
        scope: process.env.AZURE_COST_SCOPE,
        environment,
        deployments: JSON.parse(process.env.AZURE_COST_DEPLOYMENTS) as Record<
          string,
          { model: string; environment: string }
        >,
      })
    )
}
if (sources.length === 0)
  log('warn', 'no provider cost source configured; the internal leg is priced and reported alone')

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })

// An idle pooled client can fail asynchronously, outside any query: Postgres sends SQLSTATE 57P01
// ("terminating connection due to administrator command") to every connection when it restarts.
// node-pg surfaces that on the pool's emitter; with no listener Node throws it as an unhandled
// 'error' event and the process dies. Report it (never swallow) and let the pool discard the dead
// client so the next tick reconnects; a pool that keeps faulting is wedged, so exit for a clean
// restart (paired with `restart: unless-stopped`).
const MAX_CONSECUTIVE_IDLE_FAULTS = 5
let consecutiveIdleFaults = 0
pool.on('error', (error: Error & { code?: string }) => {
  consecutiveIdleFaults += 1
  log('error', 'idle pool client error', {
    code: error.code,
    error: error.message,
    consecutiveIdleFaults,
  })
  if (consecutiveIdleFaults >= MAX_CONSECUTIVE_IDLE_FAULTS) {
    log('error', 'pool wedged: exiting for a clean restart', {
      consecutiveIdleFaults,
      threshold: MAX_CONSECUTIVE_IDLE_FAULTS,
    })
    process.exit(1)
  }
})

const INTERVAL_MS = Number(process.env.COST_RECONCILER_INTERVAL_MS ?? 6 * 60 * 60 * 1000)
const WINDOW_DAYS = Number(process.env.COST_WINDOW_DAYS ?? 60)
const tolerance = {
  absoluteUsd: Number(process.env.COST_TOLERANCE_ABSOLUTE_USD ?? 0.05),
  relative: Number(process.env.COST_TOLERANCE_RELATIVE ?? 0.02),
}
const revisionLagDays = Number(process.env.COST_REVISION_LAG_DAYS ?? 30)
const reportPath = process.env.COST_REPORT_PATH ?? '/var/lib/cost-reconciler/latest.json'

let running = false
async function tick() {
  if (running) return
  running = true
  try {
    const today = new Date()
    const from = new Date(today.getTime() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)
    const to = today.toISOString().slice(0, 10)
    const report = await runReconciliation({
      query: async (sql, params) => {
        const result = await pool.query(sql, params)
        return result.rows
      },
      prices,
      environment,
      sources,
      window: { from, to },
      tolerance,
      revisionLagDays,
      today,
      reportPath,
      emit: (event) => log('warn', event.event, { ...event }),
    })
    consecutiveIdleFaults = 0 // a clean run proves the pool recovered
    log('info', 'reconciled', {
      settled: report.settled.length,
      provisional: report.provisional.length,
      drift: report.drift.length,
      unmatchedCalls: report.unmatchedCalls,
      priceVersion: report.priceVersion,
      settledThrough: report.settledThrough,
    })
  } catch (error) {
    log('error', 'reconciliation failed', { error: (error as Error).message })
  } finally {
    running = false
  }
}
log('info', 'cost-reconciler started', {
  intervalMs: INTERVAL_MS,
  routes: sources.map((s) => s.route),
})
const timer = setInterval(tick, INTERVAL_MS)
void tick()
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    clearInterval(timer)
    pool.end().then(() => process.exit(0))
  })
}
