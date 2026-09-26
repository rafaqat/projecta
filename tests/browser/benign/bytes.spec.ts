import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import db from '@adonisjs/lucid/services/db'
import { InProcessOrchestrator } from '#app/assistant/in_process'
import type { ModelRequest } from '#app/assistant/model'
import { ScriptedScopeClassifier } from '#app/retrieval/scope_classifier'
import { ScopeThrottle } from '#app/retrieval/throttle'
import { testSeams } from '#app/security/ablations'
import { startFixtureGitServer } from '#tests/helpers/git_fixtures'
import { LOOKALIKES_FIXTURE, lookalikeEntries } from '#tests/helpers/lookalikes_fixture'
import { startMockProvider } from '#tests/helpers/oidc'
import { indexFixture, type IndexedFixture } from '#tests/helpers/shop_fixture'
import { ScriptedModel, type ScriptTurn } from '#tests/helpers/scripted_model'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'
import { resetDatabase } from '#tests/helpers/db'

/**
 * What the reader sees is what was released (WP-19, BL-02, BL-24): prose
 * keeps its ligatures and zero-width joiners, and a cited span that is
 * itself markup renders as the file's own characters, never as HTML.
 */
const PROSE = 'The label is ﬁnancial and the Persian form is می‌خواهم; both are kept. '

let a: SeededWorkspace
let fixture: IndexedFixture
let provider: Awaited<ReturnType<typeof startMockProvider>>

/**
 * A citation of the whole first result, not its block 0. The premise below is "the cited span
 * shows the markup", so the span that shows it is what must be cited: since a
 * declaration's doc comment is its first block, and `IMAGE_MARKUP` has one on the line above it,
 * so block 0 alone is that comment (the index shift also caused).
 */
function wholeFirst(request: ModelRequest) {
  const blocks = request.messages
    .at(-1)!
    .content.flatMap((b) => (b.type === 'tool_result' ? b.content : [b]))
  const first = blocks.find((b) => b.type === 'search_result') as {
    source: string
    content: unknown[]
  }
  return { handle: first.source, startBlock: 0, endBlock: first.content.length - 1, citedText: '' }
}

test.group('bytes on screen (WP-19)', (group) => {
  group.setup(async () => {
    provider = await startMockProvider()
    await startFixtureGitServer()
    await resetDatabase()
    await db.from('honeytokens').delete()
    ;({ a } = await seedTwoWorkspaces())
    fixture = await indexFixture(a, 'lookalikes-bytes', await lookalikeEntries(), 'lookalikes')
    const script: ScriptTurn[] = [
      (request) => [
        {
          type: 'text',
          delta: PROSE,
          citations: [wholeFirst(request)],
        },
        { type: 'end', stopReason: 'end_turn' },
      ],
    ]
    testSeams.orchestrator = new InProcessOrchestrator({
      model: new ScriptedModel(script),
      classifier: new ScriptedScopeClassifier(() => 'explanation'),
      throttle: new ScopeThrottle(10, 600_000),
    })
  })

  test('prose renders byte-identical to the released text, and a cited markup span renders as text', async ({
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
    await page.fill('textarea[name=question]', 'What does `IMAGE_MARKUP` contain?')
    await page.click('.query-box button[type=submit]')
    await page.locator('.turn').last().locator('.answer[data-run-state=completed]').waitFor()

    const prose = await page.locator('.answer .answer-text').first().innerText()
    assert.include(prose, 'ﬁnancial', 'the ligature survives rendering')
    assert.include(prose, 'می‌خواهم', 'the zero-width non-joiner survives rendering')

    // The cited span opens beside the answer; each rendered line is the file's own line.
    await page.locator('.citation[data-verified=true]').first().click()
    await page.locator('[data-file-pane]').waitFor()
    const lines = await page
      .locator('[data-file-pane] .code-line span:nth-child(2)')
      .allTextContents()
    const source = await readFile(join(LOOKALIKES_FIXTURE, 'src/prompts/tags.ts'), 'utf8')
    const tags = source.split('\n')
    assert.isNotEmpty(lines)
    for (const line of lines) assert.include(tags, line, 'a rendered line is a verbatim file line')
    assert.isTrue(
      lines.some((l) => l.includes('<img src=x onerror="alert(1)">')),
      'markup is rendered as characters'
    )
    assert.equal(await page.locator('[data-file-pane] img').count(), 0, 'never as an element')
    assert.isUndefined(await page.evaluate('window.__canary'))
  }).tags(['AC-WP19-02', 'AC-WP19-12', 'wp19'])
})
