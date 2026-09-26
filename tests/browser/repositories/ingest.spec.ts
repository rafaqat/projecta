import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import type { MockOidcProvider } from '../../../services/mock-oidc/src/provider.js'
import { ingestQueue, INGEST_QUEUE } from '#app/ingest/queue'
import { inScope } from '#app/security/scope'
import { startMockProvider } from '#tests/helpers/oidc'
import { resetDatabase } from '#tests/helpers/db'
import { scopeOf } from '#tests/helpers/shop_fixture'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'

/**
 * The repository page before an index exists (UAT 2026-09-14): the failure
 * and its reason are on the page, Re-index queues a run and the page shows
 * it queued, and Delete (confirmed) removes the repository and returns to
 * the workspace.
 */
let provider: MockOidcProvider
let a: SeededWorkspace

async function queuedJobs(): Promise<number> {
  const { rows } = await db.rawQuery(
    `select count(*)::int as n from pgboss.job where name = :queue and state = 'created'`,
    { queue: INGEST_QUEUE }
  )
  return Number((rows as Array<{ n: number }>)[0]?.n ?? 0)
}

test.group('repository page · indexing state', (group) => {
  group.setup(async () => {
    provider = await startMockProvider()
  })
  group.each.setup(async () => {
    await resetDatabase()
    ;({ a } = await seedTwoWorkspaces())
    await ingestQueue()
    // resetDatabase truncates the public schema only; an active row another suite left in the
    // pg-boss table would count as "ahead" here.
    await db.rawQuery(`delete from pgboss.job where name = ?`, [INGEST_QUEUE])
  })

  test('shows the failure reason, queues a re-index, and deletes with confirmation', async ({
    browserContext,
    assert,
  }) => {
    await inScope(scopeOf(a), (trx) =>
      trx.from('repositories').where('id', a.open.id).update({
        status: 'failed',
        status_detail: "fatal: couldn't find remote ref refs/heads/main",
      })
    )
    provider.signInAs({ oid: a.owner.oid, tid: a.owner.tid, email: a.owner.email, name: 'Owner' })
    const login = await browserContext.visit('/auth/login')
    await login.waitForURL((url: URL) => !url.pathname.startsWith('/auth/'))
    const page = await browserContext.visit(`/w/${a.workspace.handle}/r/${a.open.handle}`)

    const panel = page.locator('[data-ingest-panel]')
    await panel.waitFor()
    assert.equal(await panel.getAttribute('data-ingest-status'), 'failed')
    assert.include(await panel.locator('[role=alert]').textContent(), 'refs/heads/main')

    await page.click('[data-ingest-actions] button:has-text("Re-index")')
    await page.locator('[data-ingest-panel][data-ingest-status="queued"]').waitFor()
    assert.equal(await queuedJobs(), 1)

    // Ignore rules: a bad pattern is refused in place; a good list is saved and marks the button.
    await page.click('[data-ingest-actions] button:has-text("Ignore rules")')
    const rules = page.locator('[data-ignore-rules]')
    await rules.waitFor()
    assert.include(await rules.inputValue(), 'node_modules/')
    await rules.fill('../etc/')
    await page.click('button:has-text("Save")')
    await page.locator('[role=dialog] [role=alert]').waitFor()
    await rules.fill('vendor/\n*.min.js\n')
    await page.click('[data-save-and-reindex]')
    await page.locator('[data-ignore-rules]').waitFor({ state: 'detached' })
    await page.locator('[data-ingest-actions] button:has-text("Ignore rules *")').waitFor()
    const saved = await inScope(scopeOf(a), (trx) =>
      trx.from('repositories').where('id', a.open.id).select('ignore_paths').first()
    )
    assert.deepEqual(saved?.ignore_paths, ['vendor/', '*.min.js'])
    assert.equal(await queuedJobs(), 2, 'the forced run is queued beside the plain one')
    //: the newest job (the forced run) is one behind the plain one, and the panel says so.
    await page.locator('[data-ingest-ahead="1"]').waitFor()
    assert.include(await page.locator('[data-ingest-ahead]').textContent(), '1 ahead')

    await page.click('[data-ingest-actions] button:has-text("Delete")')
    await page.click('[data-confirm-delete]')
    await page.waitForURL((url: URL) => url.pathname === `/w/${a.workspace.handle}`)
    const row = await inScope(scopeOf(a), (trx) =>
      trx.from('repositories').where('id', a.open.id).first()
    )
    assert.notExists(row)
  }).tags(['AC-WP03-06', 'AC-WP34-03', 'wp03', 'wp34'])
})
