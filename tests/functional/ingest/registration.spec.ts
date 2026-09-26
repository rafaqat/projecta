import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import type { MockOidcProvider } from '../../../services/mock-oidc/src/provider.js'
import { ingestQueue, INGEST_QUEUE } from '#app/ingest/queue'
import { inScope } from '#app/security/scope'
import { sessionFor, startMockProvider } from '#tests/helpers/oidc'
import { resetDatabase } from '#tests/helpers/db'
import { buildFixtureRepo, startFixtureGitServer } from '#tests/helpers/git_fixtures'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'

/**
 * Registration through the route (design §4, SEC-32): the repository row,
 * its webhook inbox with a per-repository secret, and one queued ingestion
 * job. The rejections are covered by AC-WP03-02; this is the accepted path,
 * which no test had driven to the insert.
 */
let provider: MockOidcProvider
let a: SeededWorkspace

test.group('repository registration (SEC-32)', (group) => {
  group.setup(async () => {
    provider = await startMockProvider()
    await startFixtureGitServer()
  })
  group.each.setup(async () => {
    await resetDatabase()
    ;({ a } = await seedTwoWorkspaces())
    const queue = await ingestQueue()
    await queue.deleteQueuedJobs(INGEST_QUEUE)
  })

  test('an allowlisted URL registers the repository, creates its webhook inbox and queues one ingestion', async ({
    client,
    assert,
  }) => {
    const repo = await buildFixtureRepo('fixtures', 'registered', { 'index.ts': 'export {}\n' })
    const owner = await sessionFor(client, provider, a.owner)
    const response = await client
      .post(`/w/${a.workspace.handle}/repos`)
      .header('cookie', owner.cookies)
      .header('x-xsrf-token', owner.xsrf)
      .json({ url: repo.url, name: 'registered' })
    response.assertStatus(201)
    const { handle, webhookHandle } = response.body() as { handle: string; webhookHandle: string }
    assert.match(handle, /^[0-9a-hjkmnp-tv-z]{16}$/)
    assert.match(webhookHandle, /^[0-9a-hjkmnp-tv-z]{16}$/)

    const repository = await inScope({ userId: a.owner.id, workspaceId: a.workspace.id }, (trx) =>
      trx.from('repositories').where('handle', handle).first()
    )
    assert.exists(repository)
    assert.equal(repository!.status, 'registered')
    // No branch given: HEAD until the worker resolves the remote's default branch (UAT 2026-09-14).
    assert.equal(repository!.default_ref, 'HEAD')

    const inbox = await db.from('webhook_endpoints').where('handle', webhookHandle).first()
    assert.exists(inbox, 'a webhook inbox for the repository')
    assert.equal(inbox!.repository_id, repository!.id)
    assert.equal(inbox!.workspace_id, a.workspace.id)
    assert.equal(inbox!.acts_as_user_id, a.owner.id)
    assert.match(inbox!.secret, /^[0-9a-f]{64}$/)
    assert.notInclude(
      JSON.stringify(response.body()),
      inbox!.secret,
      'the secret is never returned'
    )

    const queued = await db.rawQuery(
      "select data from pgboss.job where name = ? and state in ('created', 'active')",
      [INGEST_QUEUE]
    )
    assert.lengthOf(queued.rows, 1, 'one ingestion job queued')
    assert.equal(queued.rows[0].data.repositoryId, repository!.id)
    assert.equal(queued.rows[0].data.actorUserId, a.owner.id)
  }).tags(['AC-WP03-02', 'wp03'])

  test('the same URL registered again in a workspace is the existing repository, not a second one', async ({
    client,
    assert,
  }) => {
    // Batch UAT 2026-09-14: a re-run of the list must land on the repository it already indexed.
    const repo = await buildFixtureRepo('fixtures', 'again', { 'index.ts': 'export {}\n' })
    const owner = await sessionFor(client, provider, a.owner)
    const post = () =>
      client
        .post(`/w/${a.workspace.handle}/repos`)
        .header('cookie', owner.cookies)
        .header('x-xsrf-token', owner.xsrf)
        .json({ url: repo.url })
    const first = await post()
    first.assertStatus(201)
    const second = await post()
    second.assertStatus(200)
    assert.equal(second.body().handle, first.body().handle)
    const rows = await inScope({ userId: a.owner.id, workspaceId: a.workspace.id }, (trx) =>
      trx.from('repositories').where('url', repo.url)
    )
    assert.lengthOf(rows, 1)
    const queued = await db.rawQuery(
      "select 1 from pgboss.job where name = ? and state in ('created', 'active')",
      [INGEST_QUEUE]
    )
    assert.lengthOf(queued.rows, 1, 'no second ingestion')
    // A failed one is queued again on re-registration (the retry a re-run of a list means).
    await inScope({ userId: a.owner.id, workspaceId: a.workspace.id }, (trx) =>
      trx.from('repositories').where('url', repo.url).update({ status: 'failed' })
    )
    await db.rawQuery("update pgboss.job set state = 'completed' where name = ?", [INGEST_QUEUE])
    const third = await post()
    third.assertStatus(200)
    const requeued = await db.rawQuery(
      "select 1 from pgboss.job where name = ? and state in ('created', 'active')",
      [INGEST_QUEUE]
    )
    assert.lengthOf(requeued.rows, 1, 'a failed repository is queued again')
    const retried = await inScope({ userId: a.owner.id, workspaceId: a.workspace.id }, (trx) =>
      trx.from('repositories').where('url', repo.url).select('status', 'status_detail').first()
    )
    assert.deepEqual(
      retried,
      { status: 'registered', status_detail: null },
      'the failure is cleared'
    )
  }).tags(['AC-WP03-02', 'wp03'])
})
