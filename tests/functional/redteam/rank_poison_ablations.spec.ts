import { test } from '@japa/runner'
import { retrieve } from '#app/retrieval/hybrid'
import { scopePolicy } from '#app/retrieval/router'
import { startFixtureGitServer } from '#tests/helpers/git_fixtures'
import { resetDatabase } from '#tests/helpers/db'
import { indexShop, scopeOf, type IndexedFixture } from '#tests/helpers/shop_fixture'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'

/**
 * T-08 (poisoned retrieval ranking) names two mitigations, diversity_caps and
 * sufficiency_gate, and evals/redteam/ablations.json maps each to a flag. The
 * discrimination test (AC-WP10-03) replays only `runner: 'replay'` cases, and
 * the one T-08 case is a retrieval case, so neither flag had ever been flipped
 * (test review, 2026-09-18): the flags were declared and read by nothing. This
 * proves each one discriminates at the retrieval layer, where the mitigation lives.
 */
let a: SeededWorkspace
let fixture: IndexedFixture

test.group('T-08 mitigations discriminate under ablation', (group) => {
  group.setup(async () => {
    await startFixtureGitServer()
    await resetDatabase()
    ;({ a } = await seedTwoWorkspaces())
    fixture = await indexShop(a, 'shop-t08-ablations')
  })
  group.each.teardown(() => {
    delete process.env.ABLATION_NO_SUFFICIENCY_GATE
    delete process.env.ABLATION_NO_DIVERSITY_CAPS
  })
  group.each.timeout(120_000)

  test('sufficiency_gate: a threshold no result can meet yields insufficient_evidence; with the gate ablated the same retrieval is ok', async ({
    assert,
  }) => {
    const question = 'how is a payment refunded'
    const unreachable = { sufficiencyMinScore: Number.POSITIVE_INFINITY }
    const hardened = await retrieve(scopeOf(a), fixture.commitId, question, unreachable)
    assert.equal(hardened.status, 'insufficient_evidence')
    assert.isAbove(hardened.chunks.length, 0, 'the gate withholds the status, not the chunks')

    process.env.ABLATION_NO_SUFFICIENCY_GATE = '1'
    const ablated = await retrieve(scopeOf(a), fixture.commitId, question, unreachable)
    assert.equal(
      ablated.status,
      'ok',
      'with the gate removed, weak evidence is reported as sufficient'
    )
  }).tags(['AC-WP10-03', 'wp10'])

  test('diversity_caps: no file exceeds maxChunksPerFile and no symbol repeats; with the caps ablated one file floods the context', async ({
    assert,
  }) => {
    const cap = scopePolicy().budgets.maxChunksPerFile
    // InventoryService.ts declares six symbols: more chunks than the cap admits from one file.
    const question = 'InventoryService'
    const perFile = (chunks: Array<{ path: string }>) => {
      const counts = new Map<string, number>()
      for (const c of chunks) counts.set(c.path, (counts.get(c.path) ?? 0) + 1)
      return counts
    }
    const hardened = await retrieve(scopeOf(a), fixture.commitId, question)
    for (const [path, n] of perFile(hardened.chunks))
      assert.isAtMost(n, cap, `${path} within maxChunksPerFile`)
    const keys = hardened.chunks.filter((c) => c.symbolName).map((c) => `${c.path}#${c.symbolName}`)
    assert.equal(new Set(keys).size, keys.length, 'one chunk per symbol')

    process.env.ABLATION_NO_DIVERSITY_CAPS = '1'
    const ablated = await retrieve(scopeOf(a), fixture.commitId, question)
    const flooded = [...perFile(ablated.chunks)].some(([, n]) => n > cap)
    assert.isTrue(flooded, 'with the caps removed, a single file exceeds maxChunksPerFile')
  }).tags(['AC-WP10-03', 'wp10'])
})
