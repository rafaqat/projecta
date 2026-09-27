import { createHash, randomUUID } from 'node:crypto'
import logger from '@adonisjs/core/services/logger'
import { IngestPipeline } from '#app/ingest/pipeline'
import type { IndexOutcome } from '#app/ingest/indexer'
import { inScope } from '#app/security/scope'
import { newHandle } from '#app/security/handles'
import {
  expandQuestions,
  runUat,
  scoreExpectations,
  summarise,
  type UatExpectations,
  type UatPack,
} from '#app/assistant/uat'
import type { TurnDeps } from '#app/assistant/turn_service'
import {
  judgeRobustness,
  type Measurement,
  type RobustnessThresholds,
  type Verdict,
} from '#app/evals/robustness'

/**
 * The robustness tier's runner (WP-24): for each pinned repository, ingest the pinned
 * commit, measure what gates on, optionally ask the UAT pack, and judge.
 *
 * Every repository is measured even when an earlier one fails, and a failure is recorded — code,
 * message hash, and a failing measurement — never swallowed (owner rule) and never allowed to stop
 * the rest of the corpus.
 */
export interface CorpusEntry {
  slug: string
  commit: string
  /** Where to clone from; `https://github.com/<slug>.git` unless a test points at a fixture. */
  url?: string
  expected?: string
  vars?: string
}

export interface RobustnessConfig {
  corpus: CorpusEntry[]
  thresholds: RobustnessThresholds
}

export interface RunOptions {
  workspaceId: string
  userId: number
  config: RobustnessConfig
  mode: 'inProcess' | 'modelServer'
  only?: string[]
  pipeline?: IngestPipeline
  /**
   * Measurements a previous, cut-short run already took. Their repositories are not measured
   * again; they are judged with the rest, so resuming costs only what is missing.
   */
  carried?: RepositoryReport[]
  /**
   * Called with each repository as it is measured, so a run that is cut short — CI's step budget,
   * a cancelled job — keeps what it has already measured rather than losing all of it.
   */
  onRepository?: (report: RepositoryReport, measured: number, total: number) => void | Promise<void>
  /** Present when the UAT half runs; it needs a model the stack can reach. */
  answers?: {
    pack: UatPack
    readJson: (path: string) => Promise<unknown>
    deps?: TurnDeps
  }
}

export interface RepositoryReport extends Measurement {
  commit: string
  error?: { code: string; hash: string }
}

const urlOf = (entry: CorpusEntry) => entry.url ?? `https://github.com/${entry.slug}.git`

/**
 * The corpus row for this URL in the workspace, created if absent. Not `registerRepository`: that
 * queues an ingest of the branch head, which would race the pinned ingest. The URL policy is not
 * skipped by this — the pipeline applies it on every ingest.
 */
async function repositoryFor(options: RunOptions, entry: CorpusEntry): Promise<string> {
  const scope = { userId: options.userId, workspaceId: options.workspaceId }
  return inScope(scope, async (trx) => {
    const existing = await trx
      .from('repositories')
      .where({ workspace_id: options.workspaceId, url: urlOf(entry) })
      .select('id')
      .first()
    if (existing) return String(existing.id)
    const id = randomUUID()
    await trx.table('repositories').insert({
      id,
      handle: newHandle(),
      workspace_id: options.workspaceId,
      name: entry.slug,
      url: urlOf(entry),
      visibility: 'workspace',
      default_ref: 'HEAD',
      created_at: new Date(),
    })
    return id
  })
}

function failure(error: unknown): { code: string; hash: string } {
  const message = error instanceof Error ? error.message : String(error)
  return {
    code: (error as { code?: string }).code ?? 'E_ROBUSTNESS_INGEST',
    hash: createHash('sha256').update(message).digest('hex').slice(0, 16),
  }
}

export async function measureRepository(
  options: RunOptions,
  entry: CorpusEntry
): Promise<RepositoryReport> {
  const scope = { userId: options.userId, workspaceId: options.workspaceId }
  const failed = (error: { code: string; hash: string }): RepositoryReport => ({
    slug: entry.slug,
    commit: entry.commit,
    status: 'failed',
    parseTimeouts: 0,
    peakRssBytes: null,
    maxChunksPerFile: 0,
    error,
  })
  let repositoryId: string
  let commitId: string
  try {
    repositoryId = await repositoryFor(options, entry)
    const outcome = await (options.pipeline ?? new IngestPipeline()).run({
      workspaceId: options.workspaceId,
      repositoryId,
      actorUserId: options.userId,
      commit: entry.commit,
      // The tier measures an ingest, so one must run: an already indexed commit would be a no-op
      // reporting an old result. On a database holding the derivation cache the forced run reuses
      // embeddings, so peak memory is representative only on a fresh database — how CI runs it.
      force: true,
    })
    commitId = outcome.commitId
  } catch (error) {
    const coded = failure(error)
    logger.error({ slug: entry.slug, ...coded }, 'robustness: ingest failed')
    return failed(coded)
  }

  const facts = await inScope(scope, async (trx) => {
    const repository = await trx
      .from('repositories')
      .where('id', repositoryId)
      .select('active_commit_id', 'name')
      .first()
    const step = await trx
      .from('ingest_steps')
      .where({ repository_id: repositoryId, commit_sha: entry.commit, step: 'index' })
      .select('result')
      .first()
    const top = await trx
      .from('chunks')
      .where('commit_id', commitId)
      .groupBy('path')
      .count('* as n')
      .orderBy('n', 'desc')
      .first()
    const chunkedFiles = await trx
      .from('chunks')
      .where('commit_id', commitId)
      .countDistinct('path as n')
      .first()
    const allFiles = await trx.from('files').where('commit_id', commitId).count('* as n').first()
    return {
      active: repository?.active_commit_id === commitId,
      name: String(repository?.name ?? entry.slug),
      index: (step?.result ?? null) as Partial<IndexOutcome> | null,
      maxChunks: Number(top?.n ?? 0),
      // Files the index turned into chunks, over files in the tree: a docs-heavy repository
      // withholds more, and's withheld allowance is relative to exactly this.
      supportedFileRatio: Number(allFiles?.n ?? 0)
        ? Number(chunkedFiles?.n ?? 0) / Number(allFiles?.n)
        : 0,
    }
  })
  const skipped = facts.index?.filesSkipped ?? {}
  const report: RepositoryReport = {
    slug: entry.slug,
    commit: entry.commit,
    status: facts.active && facts.index ? 'indexed' : 'not_active',
    // Timeouts and grammar failures — not files in a language the index has no grammar for.
    parseTimeouts: (skipped.parse_timeout ?? 0) + (skipped.parse_unsupported ?? 0),
    peakRssBytes: typeof facts.index?.peakRssBytes === 'number' ? facts.index.peakRssBytes : null,
    maxChunksPerFile: facts.maxChunks,
  }
  if (!options.answers || report.status !== 'indexed') return report

  try {
    const vars = entry.vars
      ? ((await options.answers.readJson(entry.vars)) as Record<string, string>)
      : {}
    const { questions } = expandQuestions(options.answers.pack, vars)
    let cases = await runUat(
      questions,
      scope,
      { id: repositoryId, name: facts.name, activeCommitId: commitId },
      options.answers.deps
    )
    if (entry.expected) {
      const expected = (await options.answers.readJson(entry.expected)) as UatExpectations
      cases = scoreExpectations(cases, expected)
      let hit = 0
      let total = 0
      for (const c of cases) {
        if (!c.expectation) continue
        total += c.expectation.paths.expected + c.expectation.symbols.expected
        hit += c.expectation.paths.cited + c.expectation.symbols.cited
      }
      report.expectations = {
        labelled: Boolean(expected.labelled_by),
        recall: expected.labelled_by && total ? hit / total : null,
        questions: cases
          .filter((c) => c.expectation)
          .map((c) => ({
            area: c.area,
            question: c.question,
            expected: c.expectation!.paths.expected + c.expectation!.symbols.expected,
            cited: c.expectation!.paths.cited + c.expectation!.symbols.cited,
            recall: c.expectation!.recall,
            missing: [...c.expectation!.paths.missing, ...c.expectation!.symbols.missing],
          })),
      }
    }
    const { counts, failures } = summarise(cases)
    report.answers = {
      turns: cases.length,
      failed: counts.failed,
      withheld: counts.withheld,
      unverified: counts.unverified,
      supportedFileRatio: facts.supportedFileRatio,
      failures,
    }
    for (const f of failures) logger.error({ slug: entry.slug, ...f }, 'robustness: a turn failed')
  } catch (error) {
    // The UAT half failing is recorded, and the missing answers then fail the minimum sample.
    report.error = failure(error)
    logger.error({ slug: entry.slug, ...report.error }, 'robustness: answers failed')
  }
  return report
}

export async function runRobustness(
  options: RunOptions
): Promise<{ verdict: Verdict; repositories: RepositoryReport[] }> {
  const corpus = options.only
    ? options.config.corpus.filter((e) => options.only!.includes(e.slug))
    : options.config.corpus
  // A repository the carried run failed on is the one to start again at: only a measurement that
  // was actually taken is carried (owner, 2026-09-19).
  const carried = new Map(
    (options.carried ?? []).filter((r) => r.status !== 'failed').map((r) => [r.slug, r])
  )
  const toMeasure = corpus.filter((e) => !carried.has(e.slug))
  const measured: RepositoryReport[] = []
  for (const entry of toMeasure) {
    const report = await measureRepository(options, entry)
    measured.push(report)
    await options.onRepository?.(report, measured.length, toMeasure.length)
  }
  // The report holds the corpus in its own order, whoever measured each repository.
  const bySlug = new Map([...carried, ...measured.map((r) => [r.slug, r] as const)])
  const repositories = corpus.map((e) => bySlug.get(e.slug)!).filter(Boolean)
  const verdict = judgeRobustness(repositories, {
    corpus,
    thresholds: options.config.thresholds,
    mode: options.mode,
    answers: Boolean(options.answers),
  })
  return { verdict, repositories }
}
