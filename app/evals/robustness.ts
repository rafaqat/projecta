import { isAbsolute, join, relative } from 'node:path'

/**
 * The robustness tier's judge (WP-24): real repositories at pinned commits, held to
 * invariants rather than answers. Pure — measurements in, verdict out — so every threshold can be
 * tested against hand-computed figures without running a pipeline.
 *
 * Two rules shape every check. A missing measurement fails; it never passes — the lesson of the
 * detector's zero-sample "100 % recall" (2026-09-15). And a rate is judged only on enough turns
 * (`minimumSamples`); below that the repository fails on the sample, not on the rate.
 */
export interface RobustnessThresholds {
  parseTimeouts: number
  peakRssBytes: { inProcess: number; modelServer: number }
  maxChunksPerFile: number
  failedTurns: number
  /** Allowed withheld rate is (1 − supported-file ratio) + this. */
  withheldAllowance: number
  minimumSamples: number
  expectationRecallFloor: number
  /** leaves this for the first run to inform: null reports without gating. */
  unverifiedNameRate: number | null
}

export interface Measurement {
  slug: string
  status: string
  parseTimeouts: number
  peakRssBytes: number | null
  maxChunksPerFile: number
  answers?: {
    turns: number
    failed: number
    withheld: number
    unverified: number
    /** Files the index parses, over files in the tree: a docs-heavy repository withholds more. */
    supportedFileRatio: number
    /**
     * Each failed turn, named: the question, and the code and hash that find it in the logs. The
     * first paid run said "failed turns 1" and nothing else (2026-09-20); a report that fails an
     * invariant says why. Absent on reports written before this was recorded.
     */
    failures?: Array<{ area: string; question: string; code: string; hash: string }>
  }
  /** Only for a repository with owner-labelled expected citations. */
  expectations?: {
    labelled: boolean
    recall: number | null
    /** Each labelled question: how many expected citations it made, and which it missed. */
    questions?: Array<{
      area: string
      question: string
      expected: number
      cited: number
      recall: number
      missing: string[]
    }>
  }
}

export interface Check {
  name: string
  value: number | string | null
  limit: number | string | null
  ok: boolean
  /** A reported-only check never fails the run. */
  gating: boolean
}

export interface Verdict {
  ok: boolean
  mode: 'inProcess' | 'modelServer'
  answersRun: boolean
  repositories: Array<{ slug: string; ok: boolean; checks: Check[] }>
}

export interface JudgeOptions {
  corpus: Array<{ slug: string; expected?: string }>
  thresholds: RobustnessThresholds
  mode: 'inProcess' | 'modelServer'
  /** Whether the UAT half ran; if not, answer invariants are reported as not run. */
  answers: boolean
}

const gate = (name: string, value: number | null, limit: number | string, ok: boolean): Check => ({
  name,
  value,
  limit,
  ok: value !== null && ok,
  gating: true,
})
const notRun = (name: string): Check => ({
  name,
  value: 'not run',
  limit: null,
  ok: true,
  gating: false,
})

function answerChecks(m: Measurement, t: RobustnessThresholds, hasExpectations: boolean): Check[] {
  const a = m.answers
  if (!a) {
    return [
      gate('minimum samples', null, t.minimumSamples, false),
      ...(hasExpectations
        ? [gate('expected-citation recall', null, t.expectationRecallFloor, false)]
        : []),
    ]
  }
  const checks: Check[] = [
    gate('minimum samples', a.turns, t.minimumSamples, a.turns >= t.minimumSamples),
  ]
  if (a.turns >= t.minimumSamples) {
    const withheldRate = a.withheld / a.turns
    const allowed = 1 - a.supportedFileRatio + t.withheldAllowance
    const unverifiedRate = a.unverified / a.turns
    checks.push(
      gate('failed turns', a.failed, t.failedTurns, a.failed <= t.failedTurns),
      gate('withheld rate', withheldRate, allowed, withheldRate <= allowed),
      t.unverifiedNameRate === null
        ? {
            name: 'unverified-name rate',
            value: unverifiedRate,
            limit: 'measure; not yet set',
            ok: true,
            gating: false,
          }
        : gate(
            'unverified-name rate',
            unverifiedRate,
            t.unverifiedNameRate,
            unverifiedRate <= t.unverifiedNameRate
          )
    )
  }
  if (hasExpectations) {
    const e = m.expectations
    // Unlabelled is a failure, not a skip: the second oracle exists only once a person labels it.
    const recall = e?.labelled ? e.recall : null
    checks.push(
      gate(
        'expected-citation recall',
        recall,
        t.expectationRecallFloor,
        recall !== null && recall >= t.expectationRecallFloor
      )
    )
  }
  return checks
}

export function judgeRobustness(measured: Measurement[], options: JudgeOptions): Verdict {
  const { thresholds: t, mode } = options
  const repositories = options.corpus.map(({ slug, expected }) => {
    const m = measured.find((x) => x.slug === slug)
    if (!m) {
      const checks = [gate('measured', null, 'a measurement', false)]
      return { slug, ok: false, checks }
    }
    const ceiling = t.peakRssBytes[mode]
    const checks: Check[] = [
      gate('indexed', m.status === 'indexed' ? 1 : 0, 1, m.status === 'indexed'),
      gate('parse timeouts', m.parseTimeouts, t.parseTimeouts, m.parseTimeouts <= t.parseTimeouts),
      gate(
        'peak memory',
        m.peakRssBytes,
        ceiling,
        m.peakRssBytes !== null && m.peakRssBytes <= ceiling
      ),
      gate(
        'chunks per file',
        m.maxChunksPerFile,
        t.maxChunksPerFile,
        m.maxChunksPerFile <= t.maxChunksPerFile
      ),
      ...(options.answers
        ? answerChecks(m, t, Boolean(expected))
        : [
            notRun('failed turns'),
            notRun('withheld rate'),
            notRun('unverified-name rate'),
            ...(expected ? [notRun('expected-citation recall')] : []),
          ]),
    ]
    return { slug, ok: checks.every((c) => !c.gating || c.ok), checks }
  })
  return { ok: repositories.every((r) => r.ok), mode, answersRun: options.answers, repositories }
}

/**
 * Where the command reads an input from. In the worker the inputs are streamed into a directory
 * under /tmp (`make robustness`), so a relative path — the corpus, the UAT pack, the files the
 * pack names — resolves against it; with no directory it is the working directory, as from source.
 */
export function inputPath(inputs: string | undefined, path: string): string {
  if (!inputs || isAbsolute(path)) return path
  const resolved = join(inputs, path)
  if (relative(inputs, resolved).startsWith('..'))
    throw new Error(`input path ${path} is outside ${inputs}`)
  return resolved
}
