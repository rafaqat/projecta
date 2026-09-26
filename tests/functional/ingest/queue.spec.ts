import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import db from '@adonisjs/lucid/services/db'
import { reindexStale, staleRepositories } from '#app/ingest/reindex'
import { BULK_PRIORITY, queuePosition } from '#app/ingest/queue'
import { SCAN_VERSION } from '#app/parse/prose'
import { CHUNKER_VERSION } from '#app/parse/chunker'
import {
  enqueueIngest,
  INGEST_EXPIRE_SECONDS,
  INGEST_QUEUE,
  ingestQueue,
  reclaimOrphanedJobs,
  startIngestWorker,
  stopIngestQueue,
} from '#app/ingest/queue'
import { newHandle } from '#app/security/handles'
import { inScope } from '#app/security/scope'
import { buildFixtureRepo, startFixtureGitServer } from '#tests/helpers/git_fixtures'
import { seedTwoWorkspaces } from '#tests/helpers/tenancy'
import { resetDatabase } from '#tests/helpers/db'

test.group('ingest queue', (group) => {
  group.setup(async () => {
    await startFixtureGitServer()
    const boss = await ingestQueue()
    await boss.deleteQueuedJobs(INGEST_QUEUE)
    await startIngestWorker()
  })
  // The worker is this group's; left running it would take jobs later suites only mean to
  // queue (CI run 34885860472).
  group.teardown(() => stopIngestQueue())
  group.each.setup(async () => {
    await resetDatabase()
  })
  group.each.timeout(90_000)

  test('a queued job carries its actor, is de-duplicated per repository and ref, and indexes the repository', async ({
    assert,
  }) => {
    const { a } = await seedTwoWorkspaces()
    const repo = await buildFixtureRepo('fixtures', 'queued', {
      'index.ts': 'export const queued = true\n',
    })
    const repositoryId = randomUUID()
    await inScope({ userId: a.owner.id, workspaceId: a.workspace.id }, (trx) =>
      trx.table('repositories').insert({
        id: repositoryId,
        workspace_id: a.workspace.id,
        handle: newHandle(),
        name: 'queued',
        url: repo.url,
        visibility: 'workspace',
        default_ref: 'main',
        created_at: new Date(),
      })
    )
    const job = {
      workspaceId: a.workspace.id,
      repositoryId,
      ref: 'main',
      actorUserId: a.owner.id,
      trigger: 'manual' as const,
    }
    const first = await enqueueIngest(job)
    const second = await enqueueIngest(job)
    assert.isString(first)
    assert.isNull(second, 'the same repository and ref is not queued twice while pending')

    let status = 'registered'
    for (let i = 0; i < 40 && status !== 'indexed'; i++) {
      await sleep(1000)
      const row = await inScope({ userId: a.owner.id, workspaceId: a.workspace.id }, (trx) =>
        trx.from('repositories').where('id', repositoryId).first()
      )
      status = row.status
    }
    assert.equal(status, 'indexed')

    const stored = await db.rawQuery('select data from pgboss.job where id = ?', [first])
    assert.equal(
      stored.rows[0].data.actorUserId,
      a.owner.id,
      'the job carries the triggering actor'
    )
    const steps = await inScope({ userId: a.owner.id, workspaceId: a.workspace.id }, (trx) =>
      trx
        .from('ingest_steps')
        .where('repository_id', repositoryId)
        .select('step', 'status', 'actor_user_id')
    )
    // resolve, read_tree, cochange, index, activate
    assert.sameMembers(
      steps.map((s) => s.step),
      ['resolve', 'read_tree', 'cochange', 'index', 'activate']
    )
    assert.isTrue(steps.every((s) => s.status === 'done' && s.actor_user_id === a.owner.id))
  }).tags(['AC-WP03-06', 'wp03'])

  test('a job left active by a worker that died is retried when the next worker starts; a run may take hours', async ({
    assert,
  }) => {
    // Batch UAT 2026-09-15: Acode's run was cut at 1800 s and restarted; tvbox's job sat
    // "active" for 30 minutes after a kernel OOM kill before pg-boss expired it.
    assert.isAtLeast(INGEST_EXPIRE_SECONDS, 4 * 3600)
    const boss = await ingestQueue()
    const id = randomUUID()
    // An active job nobody is working, well past the heartbeat-stale window and never heartbeated:
    // what a killed worker leaves behind (tvbox sat active for 30 minutes before pg-boss expired it).
    await db.rawQuery(
      `insert into pgboss.job (id, name, data, state, started_on, created_on, retry_limit, retry_count, expire_seconds)
       values (?, ?, ?, 'active', now() - interval '30 minutes', now() - interval '31 minutes', 3, 0, ?)`,
      [
        id,
        INGEST_QUEUE,
        JSON.stringify({ workspaceId: 'w', repositoryId: 'r', ref: 'HEAD', actorUserId: 1 }),
        INGEST_EXPIRE_SECONDS,
      ]
    )
    const reclaimed = await reclaimOrphanedJobs(boss)
    assert.deepEqual(reclaimed, [id])
    const row = await db.rawQuery('select state, retry_count from pgboss.job where id = ?', [id])
    assert.equal(row.rows[0].state, 'retry', 'queued again, not lost and not left active')
    await boss.cancel(INGEST_QUEUE, id)
  }).tags(['AC-WP03-06', 'wp03'])

  test('a job a live peer is heartbeating is NOT reclaimed (several workers, no duplicate ingest)', async ({
    assert,
  }) => {
    const boss = await ingestQueue()
    const id = randomUUID()
    // Active only two minutes but the owning worker is still beating: a second worker starting must
    // leave it alone, or the same repository is ingested twice.
    await db.rawQuery(
      `insert into pgboss.job (id, name, data, state, started_on, created_on, retry_limit, retry_count, expire_seconds)
       values (?, ?, ?, 'active', now() - interval '2 minutes', now() - interval '3 minutes', 3, 0, ?)`,
      [
        id,
        INGEST_QUEUE,
        JSON.stringify({ workspaceId: 'w', repositoryId: 'r', ref: 'HEAD', actorUserId: 1 }),
        INGEST_EXPIRE_SECONDS,
      ]
    )
    await db.rawQuery(
      `insert into worker_job_heartbeats (job_id, worker_id, beat_at) values (?, 'peer', now())`,
      [id]
    )
    const reclaimed = await reclaimOrphanedJobs(boss)
    assert.notInclude(reclaimed, id, 'a heartbeating peer job is left running')
    const row = await db.rawQuery('select state from pgboss.job where id = ?', [id])
    assert.equal(row.rows[0].state, 'active', 'still active, not failed out from under the peer')
    await boss.cancel(INGEST_QUEUE, id)
    await db.rawQuery('delete from worker_job_heartbeats where job_id = ?', [id])
  }).tags(['AC-WP03-06', 'wp03'])

  test('a job whose heartbeat has gone stale IS reclaimed even if it started recently', async ({
    assert,
  }) => {
    const boss = await ingestQueue()
    const id = randomUUID()
    await db.rawQuery(
      `insert into pgboss.job (id, name, data, state, started_on, created_on, retry_limit, retry_count, expire_seconds)
       values (?, ?, ?, 'active', now() - interval '2 minutes', now() - interval '3 minutes', 3, 0, ?)`,
      [
        id,
        INGEST_QUEUE,
        JSON.stringify({ workspaceId: 'w', repositoryId: 'r', ref: 'HEAD', actorUserId: 1 }),
        INGEST_EXPIRE_SECONDS,
      ]
    )
    // The worker died mid-run: its last beat is older than the stale window.
    await db.rawQuery(
      `insert into worker_job_heartbeats (job_id, worker_id, beat_at)
       values (?, 'dead', now() - interval '10 minutes')`,
      [id]
    )
    const reclaimed = await reclaimOrphanedJobs(boss)
    assert.deepEqual(reclaimed, [id])
    const row = await db.rawQuery('select state from pgboss.job where id = ?', [id])
    assert.equal(row.rows[0].state, 'retry', 'a dead worker’s job is requeued')
    await boss.cancel(INGEST_QUEUE, id)
  }).tags(['AC-WP03-06', 'wp03'])
})

/**
 * (WP-29): an index cut by another chunker stays that way until a forced re-derive, so an
 * operator can find every such repository and queue exactly those.
 */
test.group('repository:reindex --stale (WP-29)', (group) => {
  group.each.setup(async () => {
    await resetDatabase()
    const boss = await ingestQueue()
    await boss.deleteQueuedJobs(INGEST_QUEUE)
  })

  test('only repositories whose active commit carries another chunker version are stale, and each gets one forced job', async ({
    assert,
  }) => {
    const { a } = await seedTwoWorkspaces()
    const scope = { userId: a.owner.id, workspaceId: a.workspace.id }
    // Two indexed repositories, minted directly: one on the current chunker, one cut by cast-v0.
    const mint = async (
      name: string,
      version: string,
      scanVersion: string | null = SCAN_VERSION
    ) => {
      const repositoryId = randomUUID()
      const commitId = randomUUID()
      await inScope(scope, async (trx) => {
        await trx.table('repositories').insert({
          id: repositoryId,
          handle: newHandle(),
          workspace_id: a.workspace.id,
          name,
          url: `https://example.test/${name}.git`,
          visibility: 'workspace',
          default_ref: 'main',
          created_at: new Date(),
          status: 'indexed',
        })
        await trx.table('commits').insert({
          id: commitId,
          repository_id: repositoryId,
          workspace_id: a.workspace.id,
          sha: 'a'.repeat(40),
          created_at: new Date(),
        })
        await trx
          .from('repositories')
          .where('id', repositoryId)
          .update({ active_commit_id: commitId })
        await trx.table('chunks').insert({
          id: randomUUID(),
          workspace_id: a.workspace.id,
          commit_id: commitId,
          path: 'a.ts',
          blob_sha: 'b'.repeat(40),
          start_line: 1,
          end_line: 1,
          text: 'const a = 1',
          search_text: 'a',
          chunker_version: version,
          scan_version: scanVersion,
        })
      })
      return repositoryId
    }
    await mint('current', CHUNKER_VERSION)
    const staleId = await mint('stale', 'cast-v0')
    const stale = await staleRepositories(scope)
    assert.deepEqual(
      stale.map((r) => [r.name, r.versions]),
      [['stale', [`cast-v0/${SCAN_VERSION}`]]],
      'the current one is not stale'
    )
    const queued = await reindexStale(scope, a.owner.id)
    assert.deepEqual(
      queued.map((r) => [r.name, r.queued]),
      [['stale', true]]
    )
    const jobs = await db.rawQuery(
      `select data from pgboss.job where name = ? and state in ('created', 'retry')`,
      [INGEST_QUEUE]
    )
    const data = (jobs.rows as Array<{ data: Record<string, unknown> }>).map((j) => j.data)
    assert.lengthOf(data, 1)
    assert.include(data[0], { repositoryId: staleId, force: true, trigger: 'manual', ref: 'main' })
    // Queuing again is a no-op: one forced job per repository and ref.
    const again = await reindexStale(scope, a.owner.id)
    assert.deepEqual(
      again.map((r) => r.queued),
      [false]
    )
  }).tags(['AC-WP29-10', 'wp29'])

  test('a repository on the current chunker but another or no scan version is stale', async ({
    assert,
  }) => {
    const { a } = await seedTwoWorkspaces()
    const scope = { userId: a.owner.id, workspaceId: a.workspace.id }
    const mint = async (name: string, scanVersion: string | null) => {
      const repositoryId = randomUUID()
      const commitId = randomUUID()
      await inScope(scope, async (trx) => {
        await trx.table('repositories').insert({
          id: repositoryId,
          handle: newHandle(),
          workspace_id: a.workspace.id,
          name,
          url: `https://example.test/${name}.git`,
          visibility: 'workspace',
          default_ref: 'main',
          created_at: new Date(),
          status: 'indexed',
        })
        await trx.table('commits').insert({
          id: commitId,
          repository_id: repositoryId,
          workspace_id: a.workspace.id,
          sha: 'c'.repeat(40),
          created_at: new Date(),
        })
        await trx
          .from('repositories')
          .where('id', repositoryId)
          .update({ active_commit_id: commitId })
        await trx.table('chunks').insert({
          id: randomUUID(),
          workspace_id: a.workspace.id,
          commit_id: commitId,
          path: 'a.ts',
          blob_sha: 'b'.repeat(40),
          start_line: 1,
          end_line: 1,
          text: 'const a = 1',
          search_text: 'a',
          chunker_version: CHUNKER_VERSION,
          scan_version: scanVersion,
        })
      })
    }
    await mint('fresh', SCAN_VERSION)
    await mint('old-scan', 'prose-3')
    await mint('unknown-scan', null)
    const stale = await staleRepositories(scope)
    assert.deepEqual(stale.map((r) => [r.name, r.versions]).sort(), [
      ['old-scan', [`${CHUNKER_VERSION}/prose-3`]],
      ['unknown-scan', [`${CHUNKER_VERSION}/none`]],
    ])
    const queued = await reindexStale(scope, a.owner.id)
    assert.deepEqual(
      queued.map((r) => r.queued),
      [true, true]
    )
  }).tags(['AC-WP33-01', 'wp33'])
})

/**
 * (WP-34): the queue tells the truth and people go first. A bulk re-derive queues below a
 * person's request; a queued repository knows how many jobs pg-boss will take before it and which
 * repository the worker is on — named only within the same workspace.
 */
test.group('queue position and priority', (group) => {
  group.each.setup(async () => {
    await resetDatabase()
    await ingestQueue()
    // resetDatabase truncates the public schema only; a job this group marked active would
    // otherwise count as "ahead" in the next test — or as a queued job in another suite's count.
    await db.rawQuery(`delete from pgboss.job where name = ?`, [INGEST_QUEUE])
  })
  group.each.teardown(async () => {
    await db.rawQuery(`delete from pgboss.job where name = ?`, [INGEST_QUEUE])
  })

  test('a bulk job queued first is behind a manual job queued second; rows carry -10 and 0; a job in flight counts as one ahead', async ({
    assert,
  }) => {
    const { a } = await seedTwoWorkspaces()
    const scopeA = { userId: a.owner.id, workspaceId: a.workspace.id }
    const base = { workspaceId: a.workspace.id, actorUserId: a.owner.id, ref: 'main' as const }
    const bulk = await enqueueIngest(
      { ...base, repositoryId: a.open.id, trigger: 'manual', force: true },
      { priority: BULK_PRIORITY }
    )
    const manual = await enqueueIngest({
      ...base,
      repositoryId: a.restricted.id,
      trigger: 'manual',
    })
    assert.isString(bulk)
    assert.isString(manual)
    const rows = await db.rawQuery(
      `select id, priority from pgboss.job where name = ? and state = 'created'`,
      [INGEST_QUEUE]
    )
    const priority = new Map(
      (rows.rows as Array<{ id: string; priority: number }>).map((r) => [r.id, r.priority])
    )
    assert.equal(priority.get(bulk!), -10)
    assert.equal(priority.get(manual!), 0)
    assert.deepEqual(await queuePosition(scopeA, a.restricted.id), {
      ahead: 0,
      active: null,
    })
    assert.deepEqual(await queuePosition(scopeA, a.open.id), { ahead: 1, active: null })
    // A job in flight is ahead of everything queued, and is named within its workspace.
    await db.rawQuery(`update pgboss.job set state = 'active', started_on = now() where id = ?`, [
      manual,
    ])
    const open = await queuePosition(scopeA, a.open.id)
    assert.equal(open.ahead, 1)
    assert.equal(open.active?.repositoryId, a.restricted.id)
    assert.isString(open.active?.name)
    assert.deepEqual(
      await queuePosition(scopeA, a.restricted.id),
      { ahead: 0, active: null },
      'the active job itself has nothing ahead'
    )
  }).tags(['AC-WP34-01', 'wp34'])

  test('the active job of another workspace is counted but never named', async ({ assert }) => {
    const { a, b } = await seedTwoWorkspaces()
    const other = await enqueueIngest({
      workspaceId: b.workspace.id,
      repositoryId: b.open.id,
      actorUserId: b.owner.id,
      ref: 'main',
      trigger: 'manual',
    })
    await db.rawQuery(`update pgboss.job set state = 'active', started_on = now() where id = ?`, [
      other,
    ])
    await enqueueIngest({
      workspaceId: a.workspace.id,
      repositoryId: a.open.id,
      actorUserId: a.owner.id,
      ref: 'main',
      trigger: 'manual',
    })
    assert.deepEqual(
      await queuePosition({ userId: a.owner.id, workspaceId: a.workspace.id }, a.open.id),
      {
        ahead: 1,
        active: { repositoryId: null, name: null },
      }
    )
  }).tags(['AC-WP34-02', 'wp34'])
})
