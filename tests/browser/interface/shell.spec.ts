import { test } from '@japa/runner'
import { InProcessOrchestrator } from '#app/assistant/in_process'
import type { ModelRequest } from '#app/assistant/model'
import { ScriptedScopeClassifier } from '#app/retrieval/scope_classifier'
import { ScopeThrottle } from '#app/retrieval/throttle'
import { testSeams } from '#app/security/ablations'
import { startMockProvider } from '#tests/helpers/oidc'
import { freshShop, type IndexedFixture } from '#tests/helpers/shop_fixture'
import { ScriptedModel, type ScriptTurn } from '#tests/helpers/scripted_model'
import type { SeededWorkspace } from '#tests/helpers/tenancy'

let a: SeededWorkspace
let fixture: IndexedFixture
let provider: Awaited<ReturnType<typeof startMockProvider>>

// Returns undefined rather than throwing when the last message holds no search_result (e.g. a
// loaded CI runner where retrieval came back empty): the scripted turn then cites nothing and the
// answer still completes, instead of the model throwing and hanging the run at "running".
function firstHandle(request: ModelRequest): string | undefined {
  const blocks = request.messages
    .at(-1)!
    .content.flatMap((b) => (b.type === 'tool_result' ? b.content : [b]))
  return (blocks.find((b) => b.type === 'search_result') as { source: string } | undefined)?.source
}

/** Collects CSP violation reports before any page script runs (AC-WP16-01). */
const CSP_PROBE = `window.__cspViolations = []; window.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(e.violatedDirective + ' ' + e.blockedURI));`

test.group('interface shell', (group) => {
  group.setup(async () => {
    provider = await startMockProvider()
    ;({ a, fixture } = await freshShop('shop-shell'))
    const script: ScriptTurn[] = [
      (request) => {
        const handle = firstHandle(request)
        return [
          {
            type: 'text',
            delta: 'Refunds go through `refundPayment`.',
            ...(handle
              ? { citations: [{ handle, startBlock: 0, endBlock: 0, citedText: '' }] }
              : {}),
          },
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

  async function openRepository(browserContext: any) {
    await browserContext.addInitScript(CSP_PROBE)
    provider.signInAs({ oid: a.owner.oid, tid: a.owner.tid, email: a.owner.email, name: 'Owner' })
    const login = await browserContext.visit('/auth/login')
    await login.waitForURL((url: URL) => !url.pathname.startsWith('/auth/'))
    return browserContext.visit(`/w/${a.workspace.handle}/r/${fixture.repositoryHandle}`)
  }

  test('palette, menu, drawer, file pane and scheme toggle open without a CSP violation', async ({
    browserContext,
    assert,
  }) => {
    const page = await openRepository(browserContext)
    await page.locator('[data-suggested] button').first().waitFor()

    // Command palette from the keyboard, closed with Escape.
    await page.keyboard.press('Meta+k')
    await page.locator('[data-command-palette]').waitFor()
    await page.keyboard.press('Escape')
    await page.locator('[data-command-palette]').waitFor({ state: 'detached' })
    await page.keyboard.press('Control+k')
    await page.locator('[data-command-palette]').waitFor()
    await page.keyboard.press('Escape')

    // Account menu (Radix dropdown, portalled).
    await page.click('[aria-label="Account"]')
    await page.locator('[role="menuitem"]').first().waitFor()
    await page.keyboard.press('Escape')

    // A turn with a citation: file pane beside the answer, then the decision drawer.
    await page.fill('textarea[name=question]', 'How does `refundPayment` work?')
    await page.click('.query-box button[type=submit]')
    await page.locator('.turn').last().locator('.answer[data-run-state=completed]').waitFor()
    await page.locator('.citation[data-verified=true]').first().click()
    await page.locator('[data-file-pane]').waitFor()
    assert.isAtLeast(await page.locator('[data-evidence-list] [data-source]').count(), 1)
    await page.keyboard.press('Escape')
    await page.locator('[data-file-pane]').waitFor({ state: 'detached' })

    await page.click('[data-open-decision]')
    await page.locator('[data-decision-drawer] [data-config-hash]').waitFor()
    await page.keyboard.press('Escape')
    await page.locator('[data-decision-drawer]').waitFor({ state: 'detached' })

    // Everything above ran under the CSP; the reload below resets the probe, so read it first.
    assert.deepEqual(await page.evaluate('window.__cspViolations'), [])

    // Scheme toggle writes the class and the cookie; a reload keeps it server-side.
    await page.click('[data-toggle-scheme]')
    assert.isTrue(await page.evaluate("document.documentElement.classList.contains('light')"))
    const cookies = await browserContext.cookies()
    assert.equal(cookies.find((c: { name: string }) => c.name === 'scheme')?.value, 'light')
    await page.reload()
    assert.include(await page.evaluate('document.documentElement.className'), 'light')

    assert.deepEqual(await page.evaluate('window.__cspViolations'), [])
  }).tags(['AC-WP16-01', 'AC-WP16-06', 'wp16'])
})
