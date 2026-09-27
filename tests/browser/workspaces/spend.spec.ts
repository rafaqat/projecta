import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import type { MockOidcProvider } from '../../../services/mock-oidc/src/provider.js'
import { startMockProvider } from '#tests/helpers/oidc'
import { inScope } from '#app/security/scope'
import { resetDatabase } from '#tests/helpers/db'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'

/**
 * AC-WP25-05: the workspace page shows the reader their own attributed spend, and — as
 * the owner decided at acceptance — tells every member that the workspace owner can see per-member
 * spend. The owner sees the total and the per-member table, by name.
 */
let provider: MockOidcProvider
let a: SeededWorkspace

async function signInAs(browserContext: any, who: SeededWorkspace['owner'], name: string) {
  provider.signInAs({ oid: who.oid, tid: who.tid, email: who.email, name })
  const login = await browserContext.visit('/auth/login')
  await login.waitForURL((url: URL) => !url.pathname.startsWith('/auth/'))
}

/** One ledger row of Haiku 4.5 input: $1 per million tokens in the committed price table. */
async function charge(userId: number, dollars: number) {
  await inScope({ userId, workspaceId: a.workspace.id }, (trx) =>
    trx.table('llm_usage').insert({
      id: randomUUID(),
      workspace_id: a.workspace.id,
      user_id: userId,
      request_id: randomUUID().slice(0, 32),
      purpose: 'answer',
      model: 'claude-haiku-4-5-20251001',
      status: 'ok',
      input_tokens: dollars * 1_000_000,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      started_at: new Date(),
    })
  )
}

test.group('spend on the workspace page', (group) => {
  group.setup(async () => {
    provider = await startMockProvider()
  })
  group.each.setup(async () => {
    await resetDatabase()
    ;({ a } = await seedTwoWorkspaces())
    await charge(a.member.id, 3)
    await charge(a.owner.id, 5)
  })

  test('a member sees their own spend and is told the owner can see per-member spend', async ({
    browserContext,
    assert,
  }) => {
    await signInAs(browserContext, a.member, 'Ada Member')
    const page = await browserContext.visit(`/w/${a.workspace.handle}`)
    const panel = page.locator('[data-spend]')
    await panel.locator('[data-spend-own]').waitFor()
    assert.include(await panel.locator('[data-spend-own]').innerText(), '$3.00')
    assert.include(
      await panel.locator('[data-spend-disclosure]').innerText(),
      'owner can see each member'
    )
    assert.include(await panel.locator('[data-spend-note]').innerText(), 'not the provider invoice')
    assert.equal(await panel.locator('[data-spend-members]').count(), 0, 'no one else’s spend')
  }).tags(['AC-WP25-05', 'wp25'])

  test('an owner sees the workspace total and each member, by name', async ({
    browserContext,
    assert,
  }) => {
    // Ada signs in once so her display name is set, then the owner opens the page.
    await signInAs(browserContext, a.member, 'Ada Member')
    await browserContext.clearCookies()
    await signInAs(browserContext, a.owner, 'Zed Owner')
    const page = await browserContext.visit(`/w/${a.workspace.handle}`)
    const panel = page.locator('[data-spend]')
    await panel.locator('[data-spend-members]').waitFor()
    assert.include(await panel.locator('[data-spend-total]').innerText(), '$8.00')
    const rows = await panel.locator('[data-spend-member]').allInnerTexts()
    assert.lengthOf(rows, 2)
    assert.include(rows[0], 'Ada Member', 'by name: Ada before Zed although Zed spent more')
    assert.include(rows[0], '$3.00')
    assert.include(rows[1], 'Zed Owner')
    assert.include(await panel.locator('[data-spend-disclosure]').innerText(), 'Members are told')
  }).tags(['AC-WP25-05', 'wp25'])
})
