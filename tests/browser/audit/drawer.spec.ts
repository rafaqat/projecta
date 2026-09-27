import { test } from '@japa/runner'
import { InProcessOrchestrator } from '#app/assistant/in_process'
import type { ModelRequest } from '#app/assistant/model'
import { ScriptedScopeClassifier } from '#app/retrieval/scope_classifier'
import { ScopeThrottle } from '#app/retrieval/throttle'
import { testSeams } from '#app/security/ablations'
import { inScope } from '#app/security/scope'
import { startMockProvider } from '#tests/helpers/oidc'
import { freshShop, scopeOf, type IndexedFixture } from '#tests/helpers/shop_fixture'
import { ScriptedModel, type ScriptTurn } from '#tests/helpers/scripted_model'
import type { SeededWorkspace } from '#tests/helpers/tenancy'

let a: SeededWorkspace
let fixture: IndexedFixture
let provider: Awaited<ReturnType<typeof startMockProvider>>

/**
 * The handle of the block titled by `refundPayment` itself, wherever in the request it was sent:
 * a description must cite the function's body, and since the last message may
 * hold a pre-run's blocks rather than the retrieved ones.
 */
// Returns undefined rather than throwing when no search_result reached the request (e.g. a loaded
// CI runner where retrieval came back empty): the scripted turn then cites nothing and the answer
// still completes, instead of the model throwing and hanging the run at "running".
function bodyHandle(request: ModelRequest): string | undefined {
  const blocks = request.messages
    .flatMap((m) => m.content)
    .flatMap((b) => (b.type === 'tool_result' ? b.content : [b]))
    .filter((b) => b.type === 'search_result') as Array<{ source: string; title: string }>
  return (blocks.find((b) => b.title.endsWith('PaymentService.refundPayment')) ?? blocks[0])?.source
}

test.group('decision drawer (design §9)', (group) => {
  group.setup(async () => {
    provider = await startMockProvider()
    ;({ a, fixture } = await freshShop('shop-drawer'))
    const script: ScriptTurn[] = [
      (request) => {
        const handle = bodyHandle(request)
        return [
          {
            type: 'text',
            delta: 'Refunds go through `refundPayment`. ',
            // The span reaches into the body: a function described from its first line alone is
            // "described without its code".
            ...(handle
              ? { citations: [{ handle, startBlock: 0, endBlock: 1, citedText: '' }] }
              : {}),
          },
          { type: 'text', delta: 'It also logs to `AuditLogger`. ' },
          { type: 'end', stopReason: 'end_turn' },
        ]
      },
    ]
    testSeams.orchestrator = new InProcessOrchestrator({
      model: new ScriptedModel(script),
      classifier: new ScriptedScopeClassifier(() => 'explanation'),
      throttle: new ScopeThrottle(10, 600_000),
    })
  })

  test('the drawer links to About this deployment, which reports the same configHash', async ({
    browserContext,
    assert,
  }) => {
    provider.signInAs({ oid: a.owner.oid, tid: a.owner.tid, email: a.owner.email, name: 'Owner' })
    const login = await browserContext.visit('/auth/login')
    await login.waitForURL((url: URL) => !url.pathname.startsWith('/auth/'))
    const page = await browserContext.visit(
      `/w/${a.workspace.handle}/r/${fixture.repositoryHandle}`
    )
    await page.locator('[data-suggested] button').first().waitFor()
    await page.fill('textarea[name=question]', 'How does `refundPayment` work?')
    await page.click('.query-box button[type=submit]')
    await page.locator('.turn').last().locator('.answer[data-run-state=completed]').waitFor()
    await page.click('[data-open-decision]')
    const drawer = page.locator('[data-decision-drawer]')
    await drawer.locator('[data-config-hash]').waitFor()
    const shown = await drawer.locator('[data-config-hash]').innerText()
    const hash = shown.trim()
    await drawer.locator('a[data-about-link]').click()
    await page.waitForURL((url: URL) => url.pathname === '/about')
    await page.locator('[data-about-chain]').waitFor()
    const onPage = await page.locator('[data-about="config-hash"] td').innerText()
    assert.equal(onPage.trim(), hash)
    const release = await page.locator('[data-about="release"] td').innerText()
    assert.equal(
      release.trim(),
      'not recorded',
      'this environment was given no release identity (WP-14 supplies it)'
    )
  }).tags(['AC-WP26-05', 'wp26'])

  test('the drawer shows evidence states, gate outcome, verification counts, model, configHash and validation; accept and flag append decision.reviewed', async ({
    browserContext,
    assert,
  }) => {
    provider.signInAs({ oid: a.owner.oid, tid: a.owner.tid, email: a.owner.email, name: 'Owner' })
    const login = await browserContext.visit('/auth/login')
    await login.waitForURL((url: URL) => !url.pathname.startsWith('/auth/'))
    const page = await browserContext.visit(
      `/w/${a.workspace.handle}/r/${fixture.repositoryHandle}`
    )
    await page.locator('[data-suggested] button').first().waitFor()
    await page.fill('textarea[name=question]', 'How does `refundPayment` work?')
    await page.click('.query-box button[type=submit]')
    await page.locator('.turn').last().locator('.answer[data-run-state=completed]').waitFor()
    await page.click('[data-open-decision]')
    const drawer = page.locator('[data-decision-drawer]')
    await drawer.locator('[data-config-hash]').waitFor()
    assert.match(await drawer.locator('[data-config-hash]').innerText(), /^[0-9a-f]{64}$/)
    assert.include(
      await drawer.locator('[data-validation]').innerText(),
      'unvalidated configuration'
    )
    assert.include(await drawer.locator('[data-model]').innerText(), 'scripted')
    assert.include(await drawer.locator('[data-gate]').innerText(), 'evidence found')
    assert.equal(await drawer.locator('[data-gate]').getAttribute('data-withheld-by'), 'none')
    assert.match(
      await drawer.locator('[data-verification-counts]').innerText(),
      /1 verified · 1 unverified/
    )
    // The flagged-evidence count is the record's; it equals the flagged candidates the list shows
    // (JSON chunks are retrievable since WP-19 and the classifier flags some, so the value is measured, not zero).
    const flaggedCount = await drawer
      .locator('[data-injection-suspected]')
      .getAttribute('data-injection-suspected')
    assert.match(flaggedCount ?? '', /^\d+$/)
    assert.equal(
      Number(flaggedCount),
      await drawer.locator('[data-flagged-candidate]').count(),
      'the count and the flagged candidates agree'
    )
    assert.equal(
      await drawer.locator('[data-question-flagged]').getAttribute('data-question-flagged'),
      'false'
    )
    assert.isAtLeast(await drawer.locator('[data-evidence-state=used]').count(), 1)
    assert.isAtLeast(await drawer.locator('[data-evidence-state=retrieved]').count(), 1)

    await drawer.locator('textarea').fill('looks right')
    await drawer.locator('[data-review=accept]').click()
    await drawer.locator('[data-reviews] li').first().waitFor()
    await drawer.locator('[data-review=flag]').click()
    await drawer.locator('[data-reviews] li').nth(1).waitFor()
    const reviews = await drawer.locator('[data-reviews]').innerText()
    assert.include(reviews, 'accept')
    assert.include(reviews, 'looks right')
    assert.include(reviews, 'flag')
    const outbox = await inScope(scopeOf(a), (trx) =>
      trx.from('audit_outbox').where('event', 'decision.reviewed').orderBy('id')
    )
    assert.deepEqual(
      outbox.map((e) => e.payload.outcome),
      ['accept', 'flag']
    )
  }).tags(['AC-WP07-08', 'wp07', 'AC-WP18-02', 'wp18', 'AC-WP19-01', 'wp19'])
})
