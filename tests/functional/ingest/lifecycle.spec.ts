import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import type { MockOidcProvider } from '../../../services/mock-oidc/src/provider.js'
import { ingestQueue, INGEST_QUEUE } from '#app/ingest/queue'
import { inScope } from '#app/security/scope'
import { sessionFor, startMockProvider } from '#tests/helpers/oidc'
import { startFixtureGitServer } from '#tests/helpers/git_fixtures'
import { resetDatabase } from '#tests/helpers/db'
import { indexFixture, scopeOf, shopEntries } from '#tests/helpers/shop_fixture'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'
import { buildFixtureRepo } from '#tests/helpers/git_fixtures'
import { IngestPipeline, type IngestProgress } from '#app/ingest/pipeline'
import { exclusionsFor } from '#app/retrieval/exclusions'

/**
 * The repository page's view of ingestion (UAT 2026-09-14): status, steps
 * and the last failure are readable; a manager can queue a run again and can
 * delete the repository with its index; a member can do neither; a stranger
 * sees nothing (the IDOR matrix covers the routes as well).
 */
let provider: MockOidcProvider
let a: SeededWorkspace
let b: SeededWorkspace

/** Jobs waiting on the ingest queue, from the table itself (the queue's stats are refreshed on a timer). */
async function queuedJobs(): Promise<number> {
  const { rows } = await db.rawQuery(
    `select count(*)::int as n from pgboss.job where name = :queue and state = 'created'`,
    { queue: INGEST_QUEUE }
  )
  return Number((rows as Array<{ n: number }>)[0]?.n ?? 0)
}

test.group('ingest lifecycle from the repository page', (group) => {
  group.setup(async () => {
    provider = await startMockProvider()
    await startFixtureGitServer()
  })
  // Several tests index a fixture with real embeddings: slow on a CI runner.
  group.each.timeout(180_000)
  group.each.setup(async () => {
    await resetDatabase()
    ;({ a, b } = await seedTwoWorkspaces())
    const queue = await ingestQueue()
    await queue.deleteQueuedJobs(INGEST_QUEUE)
  })

  test('status reports the repository, its steps and the last failure', async ({
    client,
    assert,
  }) => {
    const owner = await sessionFor(client, provider, a.owner)
    await inScope(scopeOf(a), (trx) =>
      trx.from('repositories').where('id', a.open.id).update({
        status: 'failed',
        status_detail: "fatal: couldn't find remote ref refs/heads/main",
      })
    )
    const response = await client
      .get(`/api/w/${a.workspace.handle}/r/${a.open.handle}/ingest`)
      .header('cookie', owner.cookies)
    response.assertStatus(200)
    const body = response.body() as {
      status: string
      statusDetail: string | null
      defaultRef: string
      queued: boolean
      steps: unknown[]
    }
    assert.equal(body.status, 'failed')
    assert.include(body.statusDetail, 'refs/heads/main')
    assert.isFalse(body.queued)
    assert.isArray(body.steps)
  }).tags(['AC-WP03-06', 'wp03'])

  test('a manager queues a run again; the status shows it queued; a member is refused', async ({
    client,
    assert,
  }) => {
    const owner = await sessionFor(client, provider, a.owner)
    const queued = await client
      .post(`/api/w/${a.workspace.handle}/r/${a.open.handle}/ingest`)
      .header('cookie', owner.cookies)
      .header('x-xsrf-token', owner.xsrf)
      .accept('json')
    queued.assertStatus(202)
    const status = await client
      .get(`/api/w/${a.workspace.handle}/r/${a.open.handle}/ingest`)
      .header('cookie', owner.cookies)
    assert.isTrue((status.body() as { queued: boolean }).queued)

    const again = await client
      .post(`/api/w/${a.workspace.handle}/r/${a.open.handle}/ingest`)
      .header('cookie', owner.cookies)
      .header('x-xsrf-token', owner.xsrf)
      .accept('json')
    again.assertStatus(409)
    // A forced run is its own singleton beside the plain one.
    const forced = await client
      .post(`/api/w/${a.workspace.handle}/r/${a.open.handle}/ingest`)
      .header('cookie', owner.cookies)
      .header('x-xsrf-token', owner.xsrf)
      .accept('json')
      .json({ force: true })
    forced.assertStatus(202)
    assert.equal(await queuedJobs(), 2)

    const member = await sessionFor(client, provider, a.member)
    const refused = await client
      .post(`/api/w/${a.workspace.handle}/r/${a.open.handle}/ingest`)
      .header('cookie', member.cookies)
      .header('x-xsrf-token', member.xsrf)
      .accept('json')
    refused.assertStatus(403)
  }).tags(['AC-WP03-06', 'wp03'])

  test('deleting a repository removes its index and inbox and nothing of another workspace', async ({
    client,
    assert,
  }) => {
    const entries = await shopEntries()
    const mine = await indexFixture(a, 'shop-delete-a', entries, 'shop')
    const theirs = await indexFixture(b, 'shop-delete-b', entries, 'shop')
    const countFor = (ws: SeededWorkspace, commitId: string) =>
      inScope(scopeOf(ws), async (trx) => {
        const chunks = await trx.from('chunks').where('commit_id', commitId).count('* as n').first()
        const files = await trx.from('files').where('commit_id', commitId).count('* as n').first()
        return { chunks: Number(chunks?.n), files: Number(files?.n) }
      })
    const before = await countFor(a, mine.commitId)
    assert.isAbove(before.chunks, 0)

    const member = await sessionFor(client, provider, a.member)
    const refused = await client
      .delete(`/w/${a.workspace.handle}/r/${mine.repositoryHandle}`)
      .header('cookie', member.cookies)
      .header('x-xsrf-token', member.xsrf)
      .accept('json')
    refused.assertStatus(403)

    const owner = await sessionFor(client, provider, a.owner)
    const deleted = await client
      .delete(`/w/${a.workspace.handle}/r/${mine.repositoryHandle}`)
      .header('cookie', owner.cookies)
      .header('x-xsrf-token', owner.xsrf)
      .accept('json')
    deleted.assertStatus(204)

    assert.deepEqual(await countFor(a, mine.commitId), { chunks: 0, files: 0 })
    const row = await inScope(scopeOf(a), (trx) =>
      trx.from('repositories').where('id', mine.repositoryId).first()
    )
    assert.notExists(row)
    const inbox = await db
      .from('webhook_endpoints')
      .where('repository_id', mine.repositoryId)
      .first()
    assert.notExists(inbox, 'the webhook inbox is gone')
    const others = await countFor(b, theirs.commitId)
    assert.isAbove(others.chunks, 0, 'the other workspace is untouched')

    const gone = await client
      .get(`/w/${a.workspace.handle}/r/${mine.repositoryHandle}`)
      .header('cookie', owner.cookies)
    gone.assertStatus(404)
  }).tags(['AC-WP03-08', 'wp03'])

  test('a repository registered without a branch is indexed on the remote default branch, which is then recorded', async ({
    assert,
  }) => {
    const repo = await buildFixtureRepo('fixtures', 'head-resolution', {
      'index.ts': 'export {}\n',
    })
    await inScope(scopeOf(a), (trx) =>
      trx.from('repositories').where('id', a.open.id).update({ url: repo.url, default_ref: 'HEAD' })
    )
    const outcome = await new IngestPipeline().run({
      workspaceId: a.workspace.id,
      repositoryId: a.open.id,
      actorUserId: a.owner.id,
    })
    assert.isFalse(outcome.noop)
    const row = await inScope(scopeOf(a), (trx) =>
      trx.from('repositories').where('id', a.open.id).select('default_ref', 'status').first()
    )
    assert.equal(row?.default_ref, 'main', 'the fixture is created on main')
    assert.equal(row?.status, 'indexed')
  }).tags(['AC-WP03-06', 'wp03'])

  test('the index step reports progress per file, and the last report is on the step row', async ({
    assert,
  }) => {
    const repo = await buildFixtureRepo('fixtures', 'progress', await shopEntries())
    await inScope(scopeOf(a), (trx) =>
      trx.from('repositories').where('id', a.open.id).update({ url: repo.url, default_ref: 'main' })
    )
    const reports: IngestProgress[] = []
    await new IngestPipeline(undefined, undefined, (p) => reports.push({ ...p })).run({
      workspaceId: a.workspace.id,
      repositoryId: a.open.id,
      actorUserId: a.owner.id,
    })
    const files = reports.filter((r) => r.phase === 'files')
    assert.isAbove(files.length, 1, 'one report per file')
    assert.isTrue(
      files.every((r, i) => i === 0 || r.done >= files[i - 1].done),
      'done never decreases'
    )
    assert.equal(files.at(-1)!.done, files.at(-1)!.total, 'the last report is complete')
    assert.isTrue(
      files.slice(1, -1).every((r) => typeof r.path === 'string' && r.path.length > 0),
      'each file report names the file'
    )
    assert.includeMembers([...new Set(reports.map((r) => r.phase))], ['files', 'extract', 'clones'])
    const row = await inScope(scopeOf(a), (trx) =>
      trx
        .from('ingest_steps')
        .where({ repository_id: a.open.id, step: 'index' })
        .select('progress')
        .first()
    )
    const progress = row?.progress as IngestProgress | null
    assert.equal(progress?.phase, 'clones')
    assert.equal(progress?.done, progress?.total)
    // The file reports come in path order, so a position maps onto the file list.
    const paths = files.slice(1, -1).map((r) => r.path!)
    assert.deepEqual(paths, [...paths].sort())
  }).tags(['AC-WP03-06', 'wp03'])

  test('the status carries the commit files in path order while an index is pending', async ({
    client,
    assert,
  }) => {
    const entries = await shopEntries()
    const indexed = await indexFixture(a, 'shop-files', entries, 'shop')
    // Pending again: a queued job puts the page back on the indexing view with the list.
    const owner = await sessionFor(client, provider, a.owner)
    const idle = await client
      .get(`/api/w/${a.workspace.handle}/r/${indexed.repositoryHandle}/ingest`)
      .header('cookie', owner.cookies)
    assert.isNull((idle.body() as { files: unknown }).files, 'no list once indexed and idle')
    await client
      .post(`/api/w/${a.workspace.handle}/r/${indexed.repositoryHandle}/ingest`)
      .header('cookie', owner.cookies)
      .header('x-xsrf-token', owner.xsrf)
      .accept('json')
    const pending = await client
      .get(`/api/w/${a.workspace.handle}/r/${indexed.repositoryHandle}/ingest`)
      .header('cookie', owner.cookies)
    const body = pending.body() as { files: Array<{ path: string; change: string }> | null }
    assert.isNotNull(body.files)
    assert.isAbove(body.files!.length, 5)
    const paths = body.files!.map((f) => f.path)
    assert.deepEqual(paths, [...paths].sort())
    assert.include(paths, 'src/app.ts')
  }).tags(['AC-WP03-06', 'wp03'])

  test('ignored paths are recorded, never read, chunked or embedded, and named as exclusions', async ({
    assert,
  }) => {
    const entries = {
      ...(await shopEntries()),
      'public/assets/js/vendors/bootstrap.bundle.min.js': '!function(){console.log("bundle")}();\n',
      'node_modules/left-pad/index.js': 'module.exports = (s) => s\n',
      'vendor/thing.rb': 'puts 1\n',
    }
    const repo = await buildFixtureRepo('fixtures', 'ignored', entries)
    await inScope(scopeOf(a), (trx) =>
      trx.from('repositories').where('id', a.open.id).update({ url: repo.url, default_ref: 'main' })
    )
    const outcome = await new IngestPipeline().run({
      workspaceId: a.workspace.id,
      repositoryId: a.open.id,
      actorUserId: a.owner.id,
    })
    assert.equal(outcome.changes.ignored, 3)
    const rows = await inScope(scopeOf(a), (trx) =>
      trx
        .from('files')
        .leftJoin('blobs', (join) =>
          join
            .on('blobs.blob_sha', 'files.blob_sha')
            .andOn('blobs.workspace_id', 'files.workspace_id')
        )
        .where('files.commit_id', outcome.commitId)
        .whereNotNull('files.ignored_by')
        .select('files.path', 'files.ignored_by', 'blobs.blob_sha as read')
    )
    assert.sameMembers(
      rows.map((r) => `${r.path} ${r.ignored_by}`),
      [
        'public/assets/js/vendors/bootstrap.bundle.min.js *.min.js',
        'node_modules/left-pad/index.js node_modules/',
        'vendor/thing.rb vendor/',
      ]
    )
    assert.isTrue(
      rows.every((r) => r.read === null),
      'no blob was read for an ignored path'
    )
    const chunks = await inScope(scopeOf(a), (trx) =>
      trx.from('chunks').where('commit_id', outcome.commitId).where('path', 'like', '%bootstrap%')
    )
    assert.lengthOf(chunks, 0)
    const exclusions = await exclusionsFor(scopeOf(a), outcome.commitId)
    assert.include(
      exclusions.map((e) => `${e.path} ${e.reason}`),
      'public/assets/js/vendors/bootstrap.bundle.min.js ignored_path:*.min.js'
    )
  }).tags(['AC-WP03-04', 'wp03'])

  test('a manager sets the ignore list; a forced re-index re-derives the same commit under it', async ({
    client,
    assert,
  }) => {
    const entries = { ...(await shopEntries()), 'generated/schema.ts': 'export const s = 1\n' }
    const repo = await buildFixtureRepo('fixtures', 'ignore-list', entries)
    await inScope(scopeOf(a), (trx) =>
      trx.from('repositories').where('id', a.open.id).update({ url: repo.url, default_ref: 'main' })
    )
    const run = (force = false) =>
      new IngestPipeline().run({
        workspaceId: a.workspace.id,
        repositoryId: a.open.id,
        actorUserId: a.owner.id,
        force,
      })
    const first = await run()
    assert.equal(first.changes.ignored, 0)
    const again = await run()
    assert.isTrue(again.noop, 'the same commit again is a no-op')

    const owner = await sessionFor(client, provider, a.owner)
    const member = await sessionFor(client, provider, a.member)
    const refused = await client
      .patch(`/w/${a.workspace.handle}/r/${a.open.handle}`)
      .header('cookie', member.cookies)
      .header('x-xsrf-token', member.xsrf)
      .accept('json')
      .json({ ignorePaths: 'generated/' })
    refused.assertStatus(403)
    const bad = await client
      .patch(`/w/${a.workspace.handle}/r/${a.open.handle}`)
      .header('cookie', owner.cookies)
      .header('x-xsrf-token', owner.xsrf)
      .accept('json')
      .json({ ignorePaths: '../etc/' })
    bad.assertStatus(422)
    const saved = await client
      .patch(`/w/${a.workspace.handle}/r/${a.open.handle}`)
      .header('cookie', owner.cookies)
      .header('x-xsrf-token', owner.xsrf)
      .accept('json')
      .json({ ignorePaths: '# mine\ngenerated/\n*.min.js\n' })
    saved.assertStatus(200)
    assert.deepEqual((saved.body() as { ignorePaths: string[] }).ignorePaths, [
      'generated/',
      '*.min.js',
    ])

    const forced = await run(true)
    assert.isFalse(forced.noop)
    assert.equal(forced.commitSha, first.commitSha, 'the same commit, re-derived')
    assert.equal(forced.changes.ignored, 1)
    const status = await client
      .get(`/api/w/${a.workspace.handle}/r/${a.open.handle}/ingest`)
      .header('cookie', owner.cookies)
    const body = status.body() as { ignorePaths: string[]; ignoreIsDefault: boolean }
    assert.deepEqual(body.ignorePaths, ['generated/', '*.min.js'])
    assert.isFalse(body.ignoreIsDefault)

    const reset = await client
      .patch(`/w/${a.workspace.handle}/r/${a.open.handle}`)
      .header('cookie', owner.cookies)
      .header('x-xsrf-token', owner.xsrf)
      .accept('json')
      .json({ ignorePaths: null })
    reset.assertStatus(200)
    assert.isTrue((reset.body() as { ignoreIsDefault: boolean }).ignoreIsDefault)
  }).tags(['AC-WP03-04', 'wp03'])
})
