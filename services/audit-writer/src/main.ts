import pg from 'pg'
import { BlobAnchorStore, MemoryAnchorStore } from '../../../app/audit/anchors.js'
import { signingKeyFromSeed } from '../../../app/audit/signing.js'
import { AuditWriter } from '../../../app/audit/writer.js'

/**
 * audit-writer: the only process holding the audit_writer database
 * role and the batch signing key. Consumes the outbox every few seconds,
 * anchors chain heads to write-once storage (Azurite locally), and anchors
 * everything outstanding on shutdown.
 */
const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, msg, ...extra, at: new Date().toISOString() }))

const databaseUrl = process.env.AUDIT_WRITER_DATABASE_URL
const seed = process.env.AUDIT_SIGNING_SEED
if (!databaseUrl || !seed) {
  log('error', 'AUDIT_WRITER_DATABASE_URL and AUDIT_SIGNING_SEED are required')
  process.exit(1)
}
const connection = process.env.AZURE_STORAGE_CONNECTION_STRING
if (!connection) log('warn', 'no AZURE_STORAGE_CONNECTION_STRING: anchors are kept in memory only')

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 })

// An idle pooled client can fail asynchronously, outside any query: Postgres sends
// "terminating connection due to administrator command" (SQLSTATE 57P01) to every
// connection when it restarts, which happens on each redeploy. node-pg surfaces that
// on the pool's own emitter; with no listener Node throws it as an unhandled 'error'
// event and the process dies. We must report it (never swallow) and let the pool
// discard the dead client so the next tick checks out a fresh one.
const MAX_CONSECUTIVE_IDLE_FAULTS = 5
let consecutiveIdleFaults = 0
pool.on('error', (error: Error & { code?: string }) => {
  consecutiveIdleFaults += 1
  log('error', 'idle pool client error', {
    code: error.code,
    error: error.message,
    consecutiveIdleFaults,
  })
  // One transient fault (a Postgres restart is the common case) is resolved by the next
  // tick checking out a fresh client, which resets the count. A pool that keeps faulting
  // is wedged, and the audit chain must not silently stop consuming: exit non-zero so the
  // `restart: unless-stopped` policy replaces this process with a clean one.
  if (consecutiveIdleFaults >= MAX_CONSECUTIVE_IDLE_FAULTS) {
    log('error', 'pool wedged: exiting for a clean restart', {
      consecutiveIdleFaults,
      threshold: MAX_CONSECUTIVE_IDLE_FAULTS,
    })
    process.exit(1)
  }
})

const writer = new AuditWriter(pool, {
  key: signingKeyFromSeed(seed),
  anchors: connection ? new BlobAnchorStore(connection) : new MemoryAnchorStore(),
})

const INTERVAL_MS = Number(process.env.AUDIT_WRITER_INTERVAL_MS ?? 5000)
let running = false
async function tick() {
  if (running) return
  running = true
  try {
    const { events, anchored } = await writer.consumeOnce()
    consecutiveIdleFaults = 0 // a clean checkout proves the pool recovered
    if (events || anchored.length) log('info', 'consumed', { events, anchored })
  } catch (error) {
    log('error', 'consume failed', { error: (error as Error).message })
  } finally {
    running = false
  }
}
log('info', 'audit-writer started', { intervalMs: INTERVAL_MS })
const timer = setInterval(tick, INTERVAL_MS)
void tick()
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    clearInterval(timer)
    writer
      .anchorDue(true)
      .then((anchored) => log('info', 'anchored on shutdown', { anchored }))
      .finally(() => pool.end().then(() => process.exit(0)))
  })
}
