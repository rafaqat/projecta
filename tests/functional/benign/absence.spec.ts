import { test } from '@japa/runner'
import { routeQuestion, type RouteContext } from '#app/retrieval/answer_route'
import { exclusionsFor, exclusionsNamedBy } from '#app/retrieval/exclusions'
import { ScriptedScopeClassifier } from '#app/retrieval/scope_classifier'
import { ScopeThrottle } from '#app/retrieval/throttle'
import { startFixtureGitServer } from '#tests/helpers/git_fixtures'
import { lookalikeEntries } from '#tests/helpers/lookalikes_fixture'
import { indexFixture, scopeOf, type IndexedFixture } from '#tests/helpers/shop_fixture'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'
import { resetDatabase } from '#tests/helpers/db'

/**
 * An absence answer names what the index left out (WP-19, BL-23): when the
 * question points at a file the index skipped, the notice carries the path
 * and the reason, so "not found" is never silent about visible content.
 */
let a: SeededWorkspace
let fixture: IndexedFixture

const contextFor = (): RouteContext => ({
  scope: scopeOf(a),
  commitId: fixture.commitId,
  repository: 'lookalikes',
  commitSha: fixture.commitSha,
  classifier: new ScriptedScopeClassifier(() => 'absence'),
  throttle: new ScopeThrottle(10, 10 * 60_000),
})

test.group('lookalikes · absence names exclusions (WP-19)', (group) => {
  group.setup(async () => {
    await startFixtureGitServer()
    await resetDatabase()
    ;({ a } = await seedTwoWorkspaces())
    fixture = await indexFixture(a, 'lookalikes-absence', await lookalikeEntries(), 'lookalikes')
  })

  test('a question about a skipped file gets an absence notice naming the path and the reason', async ({
    assert,
  }) => {
    const routed = await routeQuestion('Does our code define t in minified.js?', contextFor())
    assert.equal(routed.notice?.kind, 'absence')
    assert.deepInclude(
      routed.notice?.exclusions ?? [],
      { path: 'src/encoding/minified.js', reason: 'line_too_long' },
      'the minified file was skipped for its line length and the notice says so'
    )
  }).tags(['AC-WP19-11', 'wp19'])

  test('a question that names nothing excluded carries no exclusions, and goes to the model when retrieval returns candidates', async ({
    assert,
  }) => {
    const routed = await routeQuestion('Does our code send email?', contextFor())
    assert.equal(routed.decision.label, 'absence')
    assert.deepEqual(
      exclusionsNamedBy(
        'Does our code send email?',
        await exclusionsFor(scopeOf(a), fixture.commitId)
      ),
      []
    )
    if (routed.retrieval?.status === 'ok')
      // Retrieval's score cannot tell a subject that exists from one that does not (StyleSwap,
      // 2026-09-16: 0.030 for "send email" against 0.031 for the stock screen); the model decides,
      // with <no_instance/> after a search of its own (structural: in_process.spec).
      assert.isUndefined(routed.notice)
    else {
      assert.equal(routed.notice?.kind, 'absence')
      assert.deepEqual(routed.notice?.exclusions ?? [], [])
    }
  }).tags(['AC-WP19-11', 'wp19'])
})
