import { randomUUID } from 'node:crypto'
import { PgBoss } from 'pg-boss'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { inScope, type Scope } from '#app/security/scope'
import { appMetrics } from '#app/security/telemetry/metrics'
import env from '#start/env'
import { DEFAULT_STALL_MS, withStallWatchdog, type WatchedRun } from '#app/ingest/stall'
import { IngestPipeline, type IngestOutcome } from '#app/ingest/pipeline'
import { runWithActor } from '#app/security/telemetry/actor_scope'

/**
 * pg-boss ingestion queue. Jobs carry the triggering actor, are
 * de-duplicated per (repository, ref) while queued, and retry on failure;
 * the pipeline's step records make retries resume rather than restart.
 */
export const INGEST_QUEUE = 'ingest'

export interface IngestJob {
  workspaceId: string
  repositoryId: string
  ref?: string
  actorUserId: number
  trigger: 'registration' | 'webhook' | 'manual'
  force?: boolean
}

let boss: Promise<PgBoss> | undefined

export function ingestQueue(): Promise<PgBoss> {
  boss ??= (async () => {
    const instance = new PgBoss({
      host: env.get('DB_HOST'),
      port: env.get('DB_PORT'),
      user: env.get('DB_USER'),
      password: env.get('DB_PASSWORD') ?? '',
      database: env.get('DB_DATABASE'),
      schema: 'pgboss',
      supervise: true,
    })
    instance.on('error', (error: Error) => logger.error({ err: error }, 'pg-boss error'))
    await instance.start()
    const timing = { retryLimit: 3, retryDelay: 15, expireInSeconds: INGEST_EXPIRE_SECONDS }
    await instance.createQueue(INGEST_QUEUE, { policy: 'short', ...timing })
    // createQueue leaves an existing queue as it was; the expiry changed once (2026-09-15).
    await instance.updateQueue(INGEST_QUEUE, timing)
    return instance
  })()
  return boss
}

/**
 * How long one run may take before pg-boss gives it to another worker. A
 * large repository takes hours at CPU embedding speed (batch UAT 2026-09-15:
 * Acode was cut at 1800 s and started over). A worker that dies mid-run does
 * not wait this out: the next worker reclaims what it left active.
 */
export const INGEST_EXPIRE_SECONDS = 6 * 3600

/** This worker process; stamped on the heartbeat of each job it holds so reclaim can tell whose it is. */
const WORKER_ID = randomUUID()

/** How often a worker refreshes the heartbeat of the job it is running. */
export const HEARTBEAT_MS = Number(process.env.INGEST_HEARTBEAT_MS ?? 30_000)

/** A job whose heartbeat is older than this counts as its worker having died. */
export const HEARTBEAT_STALE_SECONDS = Number(process.env.INGEST_HEARTBEAT_STALE_SECONDS ?? 120)

/** Records or refreshes the heartbeat for a job this worker is running. Best-effort: a failed write is logged, not fatal. */
async function beat(jobId: string): Promise<void> {
  await db
    .rawQuery(
      `insert into worker_job_heartbeats (job_id, worker_id, beat_at) values (:id, :worker, now())
         on conflict (job_id) do update set worker_id = excluded.worker_id, beat_at = now()`,
      { id: jobId, worker: WORKER_ID }
    )
    .catch((err) => logger.warn({ err, jobId }, 'ingest heartbeat write failed'))
}

/**
 * Reclaims only jobs whose worker has stopped heartbeating (died, OOM-killed), not every active job:
 * several workers may run at once (Azure app replicas), so failing all active jobs would reclaim a
 * live peer's work and ingest the same repository twice. Legitimate ingests run for hours
 * (INGEST_EXPIRE_SECONDS), so age alone cannot tell a dead worker's job from a busy one's — only a
 * stale heartbeat can. A job with no heartbeat yet gets a grace window equal to the stale threshold.
 */
export async function reclaimOrphanedJobs(queue: PgBoss): Promise<string[]> {
  const rows = await db.rawQuery(
    `select j.id from pgboss.job j
       left join worker_job_heartbeats h on h.job_id = j.id
      where j.name = :queue and j.state = 'active'
        and (
          (h.beat_at is null and j.started_on < now() - make_interval(secs => :stale))
          or h.beat_at < now() - make_interval(secs => :stale)
        )`,
    { queue: INGEST_QUEUE, stale: HEARTBEAT_STALE_SECONDS }
  )
  const ids = (rows.rows as Array<{ id: string }>).map((r) => r.id)
  if (ids.length === 0) return []
  await queue.fail(INGEST_QUEUE, ids, { reason: 'worker_gone' })
  await db.from('worker_job_heartbeats').whereIn('job_id', ids).delete()
  logger.warn({ jobs: ids }, 'ingest jobs whose worker stopped heartbeating were requeued')
  return ids
}

/**
 * Housekeeping queues below a person: pg-boss takes jobs by priority descending, then
 * by age, so a bulk re-derive never runs ahead of a request someone is waiting on.
 */
export const BULK_PRIORITY = -10

export async function enqueueIngest(
  job: IngestJob,
  options: { priority?: number } = {}
): Promise<string | null> {
  const queue = await ingestQueue()
  return queue.send(INGEST_QUEUE, job, {
    singletonKey: `${job.repositoryId}:${job.ref ?? 'default'}${job.force ? ':force' : ''}`,
    priority: options.priority ?? 0,
  })
}

export interface QueuePosition {
  /** Jobs pg-boss will take before this repository's: higher priority, same priority and older, and the one in flight. */
  ahead: number
  /** The repository the worker is on; named only within the same workspace. */
  active: { repositoryId: string | null; name: string | null } | null
}

/**
 * Where a repository's newest waiting job stands. `{ ahead: 0, active: null }` when
 * nothing of its own is waiting, or its own job is the one in flight.
 */
export async function queuePosition(scope: Scope, repositoryId: string): Promise<QueuePosition> {
  const workspaceId = scope.workspaceId!
  await ingestQueue()
  const mine = await db.rawQuery(
    `select id, state, priority, created_on from pgboss.job
      where name = :queue and state in ('created', 'retry', 'active')
        and data->>'workspaceId' = :workspace and data->>'repositoryId' = :repository
      order by created_on desc limit 1`,
    { queue: INGEST_QUEUE, workspace: workspaceId, repository: repositoryId }
  )
  const job = mine.rows[0] as
    { id: string; state: string; priority: number; created_on: Date } | undefined
  if (!job || job.state === 'active') return { ahead: 0, active: null }
  const ahead = await db.rawQuery(
    `select count(*)::int as n from pgboss.job
      where name = :queue and id <> :id
        and (state = 'active'
          or (state in ('created', 'retry')
            and (priority > :priority or (priority = :priority and created_on < :created))))`,
    { queue: INGEST_QUEUE, id: job.id, priority: job.priority, created: job.created_on }
  )
  const running = await db.rawQuery(
    `select data->>'workspaceId' as workspace_id, data->>'repositoryId' as repository_id
      from pgboss.job where name = :queue and state = 'active' order by started_on limit 1`,
    { queue: INGEST_QUEUE }
  )
  const active = running.rows[0] as { workspace_id: string; repository_id: string } | undefined
  let named: QueuePosition['active'] = null
  if (active) {
    named = { repositoryId: null, name: null }
    if (active.workspace_id === workspaceId) {
      const row = await inScope(scope, (trx) =>
        trx
          .from('repositories')
          .where({ id: active.repository_id, workspace_id: workspaceId })
          .select('name')
          .first()
      )
      named = { repositoryId: active.repository_id, name: row ? String(row.name) : null }
    }
  }
  return { ahead: Number((ahead.rows[0] as { n: number }).n), active: named }
}

/** Registers the worker handler; each job runs under the actor recorded on it. */
export async function startIngestWorker(pipeline?: IngestPipeline): Promise<void> {
  // Each job runs under a stall watchdog fed by the pipeline's progress reports; a
  // pipeline the caller supplies (tests) reports nothing and finishes long before the bound.
  let watched: WatchedRun<IngestOutcome> | null = null
  const runner = pipeline ?? new IngestPipeline(undefined, undefined, (p) => watched?.report(p))
  const stallMs = Number(process.env.INGEST_STALL_MS ?? DEFAULT_STALL_MS)
  const queue = await ingestQueue()
  await reclaimOrphanedJobs(queue)
  await queue.work<IngestJob, IngestOutcome[]>(
    INGEST_QUEUE,
    { batchSize: 1 },
    async (jobs: Array<{ id: string; data: IngestJob }>) => {
      const outcomes: IngestOutcome[] = []
      for (const job of jobs) {
        const actor = {
          kind: 'user' as const,
          userId: String(job.data.actorUserId),
          workspaceId: job.data.workspaceId,
        }
        const scope = { userId: job.data.actorUserId, workspaceId: job.data.workspaceId }
        // Heartbeat this job while it runs so reclaimOrphanedJobs can tell a live job from a dead
        // worker's; unref'd so it never holds the process open, cleared in the finally below.
        await beat(job.id)
        const heartbeat = setInterval(() => void beat(job.id), HEARTBEAT_MS)
        if (typeof heartbeat.unref === 'function') heartbeat.unref()
        try {
          await inScope(scope, (trx) =>
            trx
              .from('repositories')
              .where({ id: job.data.repositoryId, workspace_id: job.data.workspaceId })
              .update({ status_detail: null })
          )
          let outcome: IngestOutcome
          try {
            watched = withStallWatchdog(() => runWithActor(actor, () => runner.run(job.data)), {
              stallMs,
            })
            outcome = await watched
          } catch (error) {
            // The reason reaches the repository page (UAT 2026-09-14); pg-boss still retries.
            const message = error instanceof Error ? error.message : String(error)
            await inScope(scope, (trx) =>
              trx
                .from('repositories')
                .where({ id: job.data.repositoryId, workspace_id: job.data.workspaceId })
                .update({ status: 'failed', status_detail: message.slice(0, 2000) })
            )
            logger.error(
              {
                err: error,
                repositoryId: job.data.repositoryId,
                ref: job.data.ref,
                trigger: job.data.trigger,
              },
              'ingest job failed'
            )
            appMetrics.ingestJob('failed', job.data.trigger)
            throw error
          }
          logger.info(
            {
              repositoryId: job.data.repositoryId,
              commitSha: outcome.commitSha,
              noop: outcome.noop,
              trigger: job.data.trigger,
            },
            'ingest job finished'
          )
          appMetrics.ingestJob('finished', job.data.trigger)
          outcomes.push(outcome)
        } finally {
          clearInterval(heartbeat)
          await db
            .from('worker_job_heartbeats')
            .where('job_id', job.id)
            .delete()
            .catch(() => {})
        }
      }
      return outcomes
    }
  )
}

export async function stopIngestQueue(): Promise<void> {
  if (!boss) return
  const queue = await boss
  await queue.stop({ graceful: true, timeout: 10_000 })
  boss = undefined
}
