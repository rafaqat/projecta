import { mkdir, writeFile } from 'node:fs/promises'
import { test } from '@japa/runner'
import { runRobustness, type RobustnessConfig } from '#app/evals/robustness_runner'
import {
  buildFixtureRepo,
  commitFixtureChanges,
  startFixtureGitServer,
} from '#tests/helpers/git_fixtures'
import { resetDatabase } from '#tests/helpers/db'
import { scopeOf, shopEntries } from '#tests/helpers/shop_fixture'
import { inScope } from '#app/security/scope'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'

/**
 * AC-WP24-05: the runner over a pinned fixture corpus. Real ingests through the real
 * pipeline; only the model is scripted, and only in the answers test.
 */
const THRESHOLDS: RobustnessConfig['thresholds'] = {
  parseTimeouts: 0,
  peakRssBytes: { inProcess: 64 * 2 ** 30, modelServer: 64 * 2 ** 30 },
  maxChunksPerFile: 1000,
  failedTurns: 0,
  withheldAllowance: 0.15,
  minimumSamples: 5,
  expectationRecallFloor: 0.5,
  unverifiedNameRate: null,
}

test.group('robustness runner', (group) => {
  let a: SeededWorkspace
  let healthy: { url: string; commit: string }

  group.setup(async () => {
    await startFixtureGitServer()
    await resetDatabase()
    ;({ a } = await seedTwoWorkspaces())
    const repo = await buildFixtureRepo('fixtures', 'robust-shop', await shopEntries())
    // The pin is the first commit; the branch then moves on, as the real corpus's branches do.
    healthy = { url: repo.url, commit: repo.headSha }
    await commitFixtureChanges(repo, { 'NOTES.md': 'moved on\n' })
    // Warm the ingest path (tree-sitter grammar + ONNX embedder) once before the measured runs.
    // The isolated `--files evals/robustness_run` CI job has no earlier test to load them, and the
    // cold first ingest otherwise leaves its index step incomplete — the determinism test, a warm
    // second run, is the tell that warm succeeds. the suite is already warm by the time robustness
    // runs, so it never needed this. The throwaway run's rows are wiped by each.setup's reset.
    await run({
      corpus: [{ slug: 'fixtures/robust-shop', commit: healthy.commit, url: healthy.url }],
      thresholds: THRESHOLDS,
    }).catch(() => {})
  })
  group.each.timeout(180_000)

  const run = (
    config: RobustnessConfig,
    extra: Partial<Parameters<typeof runRobustness>[0]> = {}
  ) =>
    runRobustness({
      workspaceId: a.workspace.id,
      userId: a.owner.id,
      config,
      mode: 'inProcess',
      ...extra,
    })

  test('a healthy pinned corpus passes the ingest invariants and reports each one', async ({
    assert,
  }) => {
    const { verdict, repositories } = await run({
      corpus: [{ slug: 'fixtures/robust-shop', commit: healthy.commit, url: healthy.url }],
      thresholds: THRESHOLDS,
    })
    assert.isTrue(verdict.ok, JSON.stringify(verdict.repositories[0].checks))
    assert.isFalse(verdict.answersRun)
    const r = repositories[0]
    assert.equal(r.status, 'indexed')
    assert.equal(r.commit, healthy.commit)
    assert.isAbove(r.maxChunksPerFile, 0)
    assert.isNumber(r.peakRssBytes)
    const names = verdict.repositories[0].checks.map((c) => c.name)
    assert.includeMembers(names, ['indexed', 'parse timeouts', 'peak memory', 'chunks per file'])
  }).tags(['AC-WP24-05', 'wp24'])

  test('a second run over an already indexed commit ingests again, so every run is a measurement', async ({
    assert,
  }) => {
    const config = {
      corpus: [{ slug: 'fixtures/robust-shop', commit: healthy.commit, url: healthy.url }],
      thresholds: THRESHOLDS,
    }
    const finishedAt = async () => {
      const row = (await inScope(scopeOf(a), (trx) =>
        trx
          .from('ingest_steps')
          .where({ commit_sha: healthy.commit, step: 'index' })
          .max('finished_at as at')
          .first()
      )) as { at: Date }
      return new Date(row.at).getTime()
    }
    await run(config)
    const first = await finishedAt()
    const { repositories } = await run(config)
    assert.isAbove(await finishedAt(), first, 'the index step ran again, not a no-op')
    assert.isNumber(repositories[0].peakRssBytes, 'and so it was measured')
  }).tags(['AC-WP24-05', 'wp24'])

  test('a repository that cannot be ingested fails the run with a coded error, and the rest is still measured', async ({
    assert,
  }) => {
    const { verdict, repositories } = await run({
      corpus: [
        {
          slug: 'fixtures/robust-missing',
          commit: 'f'.repeat(40),
          url: healthy.url.replace('robust-shop', 'robust-missing'),
        },
        { slug: 'fixtures/robust-shop', commit: healthy.commit, url: healthy.url },
      ],
      thresholds: THRESHOLDS,
    })
    assert.isFalse(verdict.ok)
    const missing = repositories.find((r) => r.slug === 'fixtures/robust-missing')!
    assert.equal(missing.status, 'failed')
    assert.match(
      String(missing.error?.hash),
      /^[0-9a-f]{16}$/,
      'the cause is recorded, not swallowed'
    )
    assert.isTrue(verdict.repositories.find((r) => r.slug === 'fixtures/robust-shop')!.ok)
  }).tags(['AC-WP24-05', 'wp24'])

  test('each repository is reported as it is measured, so a run cut short keeps its measurements', async ({
    assert,
  }) => {
    // A run killed at CI's step budget wrote nothing at all: the report was assembled at the end
    // (run 35464404085). The runner now hands every repository over as it finishes.
    const seen: Array<{ slug: string; measured: number; total: number }> = []
    const { repositories } = await run(
      {
        corpus: [
          { slug: 'fixtures/robust-shop', commit: healthy.commit, url: healthy.url },
          { slug: 'fixtures/robust-missing', commit: healthy.commit, url: 'file:///nonexistent' },
        ],
        thresholds: THRESHOLDS,
      },
      {
        onRepository: (report, measured, total) => {
          seen.push({ slug: report.slug, measured, total })
        },
      }
    )
    assert.deepEqual(
      seen,
      [
        { slug: 'fixtures/robust-shop', measured: 1, total: 2 },
        { slug: 'fixtures/robust-missing', measured: 2, total: 2 },
      ],
      'both repositories are handed over in corpus order, the failing one included'
    )
    assert.lengthOf(repositories, 2)
  }).tags(['AC-WP24-05', 'wp24'])

  test('a run resumes from measurements it carries in, and judges the whole corpus', async ({
    assert,
  }) => {
    // A run cut short leaves a partial report; the next one carries it in, measures only what is
    // missing, and still judges every repository in the corpus (owner, 2026-09-19).
    const corpus = [
      { slug: 'fixtures/robust-shop', commit: healthy.commit, url: healthy.url },
      { slug: 'fixtures/robust-second', commit: healthy.commit, url: healthy.url },
    ]
    const first = await run({ corpus: [corpus[0]], thresholds: THRESHOLDS })
    const measured: string[] = []
    const { verdict, repositories } = await run(
      { corpus, thresholds: THRESHOLDS },
      {
        carried: first.repositories,
        onRepository: (report) => {
          measured.push(report.slug)
        },
      }
    )
    assert.deepEqual(
      measured,
      ['fixtures/robust-second'],
      'the carried repository is not measured again'
    )
    assert.deepEqual(
      repositories.map((r) => r.slug),
      ['fixtures/robust-shop', 'fixtures/robust-second'],
      'the report holds the whole corpus, in its order'
    )
    assert.lengthOf(verdict.repositories, 2)
    assert.isTrue(verdict.ok, JSON.stringify(verdict.repositories))
  }).tags(['AC-WP24-05', 'wp24'])

  test('a carried repository that failed is measured again — resume starts where it died', async ({
    assert,
  }) => {
    const corpus = [{ slug: 'fixtures/robust-shop', commit: healthy.commit, url: healthy.url }]
    const failed = await run({
      corpus: [{ ...corpus[0], url: 'file:///nonexistent' }],
      thresholds: THRESHOLDS,
    })
    assert.equal(failed.repositories[0].status, 'failed')
    const measured: string[] = []
    const { verdict } = await run(
      { corpus, thresholds: THRESHOLDS },
      {
        carried: failed.repositories,
        onRepository: (report) => {
          measured.push(report.slug)
        },
      }
    )
    assert.deepEqual(measured, ['fixtures/robust-shop'], 'the failure is retried, not carried')
    assert.isTrue(verdict.ok, JSON.stringify(verdict.repositories))
  }).tags(['AC-WP24-05', 'wp24'])

  test('the measured fixture greens the harness robustness tier via evals/runs/robustness.latest.json', async ({
    assert,
  }) => {
    // The slice-0 harness (evals/harness/results.ts measureTier) reads evals/runs/robustness.latest.json
    // and greens the tier from it. The runner is the measurement that writes it: the same
    // RepositoryReport the invariants are judged on, mapped to the tier's metric keys (metrics.ts).
    const { repositories } = await run({
      corpus: [{ slug: 'fixtures/robust-shop', commit: healthy.commit, url: healthy.url }],
      thresholds: THRESHOLDS,
    })
    const r = repositories[0]
    assert.equal(r.status, 'indexed')
    const metrics = {
      ingest_indexed: r.status === 'indexed' ? 1 : 0,
      parse_timeouts: r.parseTimeouts,
      // The real measured bytes, never a placeholder: peak_rss_bytes is gated on the true figure.
      peak_rss_bytes: r.peakRssBytes ?? 0,
      max_chunks_per_file: r.maxChunksPerFile,
    }
    const runs = new URL('../../../evals/runs/', import.meta.url)
    await mkdir(runs, { recursive: true })
    await writeFile(
      new URL('robustness.latest.json', runs),
      JSON.stringify({ generatedAt: new Date().toISOString(), metrics }, null, 2) + '\n'
    )
  }).tags(['AC-WP24-05', 'wp24'])
})
