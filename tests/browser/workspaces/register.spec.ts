import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import type { MockOidcProvider } from '../../../services/mock-oidc/src/provider.js'
import { ingestQueue, INGEST_QUEUE } from '#app/ingest/queue'
import { startMockProvider } from '#tests/helpers/oidc'
import { newHandle } from '#app/security/handles'
import { inScope } from '#app/security/scope'
import { scopeOf } from '#tests/helpers/shop_fixture'
import { resetDatabase } from '#tests/helpers/db'
import { buildFixtureRepo, startFixtureGitServer } from '#tests/helpers/git_fixtures'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'

/**
 * The registration form on the workspace page drives the same route the API
 * offers (design §4): the URL policy's rejection reaches the user as
 * the reason under the field, an accepted URL joins the list, and a member
 * without `manage` never sees the form.
 */
let provider: MockOidcProvider
let a: SeededWorkspace

async function signInAs(browserContext: any, who: SeededWorkspace['owner'], name: string) {
  provider.signInAs({ oid: who.oid, tid: who.tid, email: who.email, name })
  const login = await browserContext.visit('/auth/login')
  await login.waitForURL((url: URL) => !url.pathname.startsWith('/auth/'))
}

test.group('register a repository from the workspace page', (group) => {
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

  test('a rejected URL shows the policy reason; an allowlisted one appears in the list', async ({
    browserContext,
    assert,
  }) => {
    const repo = await buildFixtureRepo('fixtures', 'registered-ui', { 'index.ts': 'export {}\n' })
    await signInAs(browserContext, a.owner, 'Owner')
    const page = await browserContext.visit(`/w/${a.workspace.handle}`)
    const form = page.locator('[data-register-repository]')
    await form.waitFor()

    await form.locator('input[name=url]').fill('https://evil.example/owner/repo')
    await form.locator('button[type=submit]').click()
    await page.locator('[data-register-repository] [role=alert]').waitFor()
    assert.include(
      await page.locator('[data-register-repository] [role=alert]').textContent(),
      'host_not_allowlisted'
    )

    await form.locator('input[name=url]').fill(repo.url)
    await form.locator('input[name=name]').fill('registered-ui')
    await form.locator('button[type=submit]').click()
    await page.locator('a', { hasText: 'registered-ui' }).first().waitFor()
    assert.equal(await form.locator('input[name=url]').inputValue(), '', 'the form clears')
  }).tags(['AC-WP03-02', 'wp03'])

  test('the repository lists filter as you type, by name or URL, on the page and in the sidebar', async ({
    browserContext,
    assert,
  }) => {
    // UAT 2026-09-15: a workspace with a dozen repositories needs a search box, not a scroll.
    // Six, so the sidebar shows its filter (it appears past five repositories).
    for (const name of [
      'alpha-shop',
      'beta-api',
      'gamma-tools',
      'delta-web',
      'epsilon-cli',
      'zeta-lib',
    ]) {
      const repo = await buildFixtureRepo('fixtures', name, { 'index.ts': 'export {}\n' })
      await inScope(scopeOf(a), (trx) =>
        trx.table('repositories').insert({
          id: randomUUID(),
          handle: newHandle(),
          workspace_id: a.workspace.id,
          name,
          url: repo.url,
          visibility: 'workspace',
          default_ref: 'main',
          status: 'registered',
          created_at: new Date(),
        })
      )
    }
    await signInAs(browserContext, a.owner, 'Owner')
    const page = await browserContext.visit(`/w/${a.workspace.handle}`)
    const list = page.locator('[data-repository-list]')
    await list.locator('a').first().waitFor()
    assert.isAtLeast(await list.locator('a').count(), 6)
    await page.fill('[data-repository-filter]', 'beta')
    assert.equal(await list.locator('a').count(), 1)
    assert.include(await list.locator('a').first().innerText(), 'beta-api')
    await page.fill('[data-repository-filter]', 'gamma-tools.git')
    assert.equal(await list.locator('a').count(), 1, 'the URL matches too')
    await page.fill('[data-repository-filter]', 'nothing-like-this')
    assert.equal(await list.locator('a').count(), 0)
    assert.include(
      await page.locator('[data-repository-empty]').innerText(),
      'No repository matches'
    )

    const side = page.locator('[data-sidebar-repositories]')
    await page.fill('[data-sidebar-repository-filter]', 'alpha')
    assert.equal(await side.locator('a').count(), 1)
    assert.include(await side.locator('a').first().innerText(), 'alpha-shop')
  }).tags(['AC-WP03-02', 'wp03'])

  test('a member without manage does not see the form', async ({ browserContext, assert }) => {
    await signInAs(browserContext, a.member, 'Member')
    const page = await browserContext.visit(`/w/${a.workspace.handle}`)
    await page.locator('text=Repositories').first().waitFor()
    assert.equal(await page.locator('[data-register-repository]').count(), 0)
  }).tags(['AC-WP02-08', 'wp02'])
})
