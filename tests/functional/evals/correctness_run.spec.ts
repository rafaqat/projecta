import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { enumeration, normRoute } from '#app/evals/scorers'
import { startFixtureGitServer } from '#tests/helpers/git_fixtures'
import { resetDatabase } from '#tests/helpers/db'
import { indexShop, scopeOf, type IndexedFixture } from '#tests/helpers/shop_fixture'
import { inScope } from '#app/security/scope'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'

/**
 * Correctness tier — enumeration metric (evals/README.md; ADR-0001). The oracle
 * is human-authored (`enumeration-001.json`, labelled by Rafaqat): the exact set
 * of HTTP endpoints the node-express-shop fixture exposes. We ingest the fixture
 * through the real pipeline, read the endpoints the extractor wrote to the
 * `endpoints` table, and score them with the `enumeration` scorer — which
 * normalises both sides one-spelling-per-route (`normRoute`) before comparing.
 * The measured F1 is written to evals/runs/correctness.latest.json, which the
 * substrate harness (measureTier) reads to green `enumeration_f1`. The other
 * correctness metrics stay unmeasured (null → red) until their slices land.
 *
 * The measured value is an oracle, not the implementation graded against itself:
 * the expected set comes from the labelled case file, and `actual` from the
 * extractor's fact table.
 */

const CASE = new URL('../../../evals/cases/correctness/enumeration-001.json', import.meta.url)
const RUNS = new URL('../../../evals/runs/', import.meta.url)

interface EnumerationCase {
  oracle: { kind: 'enumeration'; of: string; expected: string[] }
}

test.group('correctness runner — endpoint enumeration (ADR-0001)', (group) => {
  let a: SeededWorkspace
  let fixture: IndexedFixture

  group.setup(async () => {
    await startFixtureGitServer()
    await resetDatabase()
    await db.from('honeytokens').delete()
    ;({ a } = await seedTwoWorkspaces())
    // Warm the ingest path (tree-sitter grammar + parser child + ONNX embedder) once before the
    // measured ingest. The isolated `--files evals/correctness_run` CI job has no earlier test to
    // load them, and the cold first ingest otherwise leaves its index step incomplete — the same
    // issue the robustness spec hit. The warm repo is a different commit, so its rows never touch
    // the measured commit's endpoints.
    await indexShop(a, 'correctness-warm').catch(() => {})
    fixture = await indexShop(a, 'correctness')
  })
  group.each.timeout(180_000)

  test('the extracted endpoints enumerate the fixture HTTP surface (enumeration_f1 ≥ 0.9)', async ({
    assert,
  }) => {
    const parsed = JSON.parse(await readFile(CASE, 'utf8')) as EnumerationCase
    const expected = parsed.oracle.expected

    // `actual`: the endpoints the extract step wrote for the measured commit, as "METHOD path".
    const rows = (await inScope(scopeOf(a), (trx) =>
      trx.from('endpoints').where('commit_id', fixture.commitId).select('method', 'path')
    )) as Array<{ method: string; path: string }>
    const actual = rows.map((r) => `${r.method} ${r.path}`)

    // `enumeration` normalises both sides with `normRoute`; normalising `actual` here as well is
    // idempotent and makes the failure message read in the same spelling the scorer compares.
    const score = enumeration(expected, actual)
    // eslint-disable-next-line @typescript-eslint/naming-convention -- metric key persisted to the results file, read by measureTier
    const enumeration_f1 = score.f1 ?? 0

    assert.isAtLeast(
      enumeration_f1,
      0.9,
      `expected ${JSON.stringify(expected.map(normRoute))} — got ${JSON.stringify(
        actual.map(normRoute)
      )}`
    )

    // Green the harness correctness tier: measureTier reads this file and gates enumeration_f1
    // on it. Only the metric actually measured is written; the rest stay null (red), as intended.
    await mkdir(RUNS, { recursive: true })
    await writeFile(
      new URL('correctness.latest.json', RUNS),
      JSON.stringify(
        { generatedAt: new Date().toISOString(), metrics: { enumeration_f1 } },
        null,
        2
      ) + '\n'
    )
  }).tags(['correctness', 'wp03'])
})
