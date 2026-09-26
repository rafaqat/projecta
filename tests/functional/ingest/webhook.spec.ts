import { test } from '@japa/runner'
import { createHmac, randomUUID } from 'node:crypto'
import type { ApiClient } from '@japa/api-client'
import db from '@adonisjs/lucid/services/db'
import { ingestQueue, INGEST_QUEUE } from '#app/ingest/queue'
import { newHandle } from '#app/security/handles'
import { inScope } from '#app/security/scope'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'
import { resetDatabase } from '#tests/helpers/db'

async function registered(ws: SeededWorkspace) {
  const repository = { id: randomUUID(), handle: newHandle() }
  const webhook = { handle: newHandle(), secret: 'whsec_' + newHandle() }
  await inScope({ userId: ws.owner.id, workspaceId: ws.workspace.id }, async (trx) => {
    await trx.table('repositories').insert({
      ...repository,
      workspace_id: ws.workspace.id,
      name: 'hooked',
      url: 'https://github.com/acme/hooked.git',
      visibility: 'workspace',
      default_ref: 'main',
      created_at: new Date(),
    })
  })
  await db.table('webhook_endpoints').insert({
    handle: webhook.handle,
    workspace_id: ws.workspace.id,
    repository_id: repository.id,
    secret: webhook.secret,
    acts_as_user_id: ws.owner.id,
    created_at: new Date(),
  })
  return { repository, webhook }
}

function deliver(
  client: ApiClient,
  hook: string,
  secret: string | null,
  body: object,
  headers: Record<string, string> = {}
) {
  const raw = JSON.stringify(body)
  const request = client
    .post(`/webhooks/github/${hook}`)
    .header('content-type', 'application/json')
    .header('x-github-event', headers['x-github-event'] ?? 'push')
    .header('x-github-delivery', headers['x-github-delivery'] ?? randomUUID())
  if (secret !== null)
    request.header(
      'x-hub-signature-256',
      `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`
    )
  return request.json(body)
}

/**
 * Live count from pg-boss's own table for one repository (its stats API is a
 * periodic snapshot). Scoped to the repository because queue.spec leaves a
 * worker running in this process, so another test's job may be active here.
 */
async function queuedJobs(repositoryId: string): Promise<number> {
  await ingestQueue()
  const result = await db.rawQuery(
    "select count(*)::int as n from pgboss.job where name = ? and data->>'repositoryId' = ? and state in ('created', 'retry', 'active')",
    [INGEST_QUEUE, repositoryId]
  )
  return result.rows[0].n
}

async function drainQueue(): Promise<void> {
  const boss = await ingestQueue()
  await boss.deleteQueuedJobs(INGEST_QUEUE)
}

test.group('push webhooks (SEC-32)', (group) => {
  group.each.setup(async () => {
    await resetDatabase()
    await drainQueue()
  })
  group.each.timeout(60_000)

  test('a delivery with an invalid signature is rejected before any scoped read', async ({
    client,
    assert,
  }) => {
    const { a } = await seedTwoWorkspaces()
    const { repository, webhook } = await registered(a)
    const wrongSecret = await deliver(client, webhook.handle, 'not-the-secret', {
      ref: 'refs/heads/main',
    })
    wrongSecret.assertStatus(404)
    const noSignature = await deliver(client, webhook.handle, null, { ref: 'refs/heads/main' })
    noSignature.assertStatus(404)
    const unknownHook = await deliver(client, newHandle(), webhook.secret, {
      ref: 'refs/heads/main',
    })
    unknownHook.assertStatus(404)
    assert.equal(await queuedJobs(repository.id), 0)
  }).tags(['AC-WP03-10', 'wp03'])

  test('pushes to non-configured refs do not index', async ({ client, assert }) => {
    const { a } = await seedTwoWorkspaces()
    const { repository, webhook } = await registered(a)
    const feature = await deliver(client, webhook.handle, webhook.secret, {
      ref: 'refs/heads/feature/x',
    })
    feature.assertStatus(200)
    feature.assertBodyContains({ outcome: 'ref_ignored' })
    const tag = await deliver(client, webhook.handle, webhook.secret, { ref: 'refs/tags/v1' })
    tag.assertBodyContains({ outcome: 'ref_ignored' })
    const ping = await deliver(
      client,
      webhook.handle,
      webhook.secret,
      { zen: 'x' },
      { 'x-github-event': 'ping' }
    )
    ping.assertBodyContains({ outcome: 'event_ignored' })
    assert.equal(await queuedJobs(repository.id), 0)
  }).tags(['AC-WP03-10', 'wp03'])

  test('a push to the configured ref queues exactly one job and duplicate delivery IDs are ignored', async ({
    client,
    assert,
  }) => {
    const { a } = await seedTwoWorkspaces()
    const { repository, webhook } = await registered(a)
    const delivery = randomUUID()
    const first = await deliver(
      client,
      webhook.handle,
      webhook.secret,
      { ref: 'refs/heads/main' },
      { 'x-github-delivery': delivery }
    )
    first.assertBodyContains({ outcome: 'queued' })
    const replay = await deliver(
      client,
      webhook.handle,
      webhook.secret,
      { ref: 'refs/heads/main' },
      { 'x-github-delivery': delivery }
    )
    replay.assertBodyContains({ outcome: 'duplicate' })
    assert.equal(await queuedJobs(repository.id), 1)
    const deliveries = await inScope({ userId: a.owner.id, workspaceId: a.workspace.id }, (trx) =>
      trx.from('webhook_deliveries').select('delivery_id', 'outcome')
    )
    assert.deepEqual(deliveries, [{ delivery_id: delivery, outcome: 'queued' }])
  }).tags(['AC-WP03-10', 'wp03'])

  test('a delivery stuck at received (its earlier enqueue failed) is re-driven, not dropped as a duplicate', async ({
    client,
    assert,
  }) => {
    const { a } = await seedTwoWorkspaces()
    const { repository, webhook } = await registered(a)
    const delivery = randomUUID()
    // A prior attempt recorded the delivery but its post-commit enqueue never landed (a transient
    // pg-boss failure), so it is still 'received' and no job was queued.
    await inScope({ userId: a.owner.id, workspaceId: a.workspace.id }, (trx) =>
      trx.table('webhook_deliveries').insert({
        workspace_id: a.workspace.id,
        repository_id: repository.id,
        delivery_id: delivery,
        outcome: 'received',
        received_at: new Date(),
      })
    )
    assert.equal(await queuedJobs(repository.id), 0)
    // GitHub retries the same delivery id: it must enqueue now, not be discarded as a duplicate.
    const retry = await deliver(
      client,
      webhook.handle,
      webhook.secret,
      { ref: 'refs/heads/main' },
      { 'x-github-delivery': delivery }
    )
    retry.assertBodyContains({ outcome: 'queued' })
    assert.equal(await queuedJobs(repository.id), 1)
    const rows = await inScope({ userId: a.owner.id, workspaceId: a.workspace.id }, (trx) =>
      trx.from('webhook_deliveries').where('delivery_id', delivery).select('outcome')
    )
    assert.deepEqual(rows, [{ outcome: 'queued' }])
  }).tags(['AC-WP03-10', 'wp03'])
})
