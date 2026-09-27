import { answerTurn, type TurnDeps } from '#app/assistant/turn_service'
import type { AnswerEvent } from '#app/assistant/protocol'
import type { EvidenceGate } from '#app/assistant/evidence_gate'
import { verifyCitations } from '#app/assistant/smoke'
import { securityEvents } from '#app/security/events/index'
import type { Scope } from '#app/security/scope'

/**
 * The UAT question pack (owner, 2026-09-14): a fixed set of questions per
 * area, asked of a registered repository through the real turn pipeline,
 * each turn classified so a run says what went wrong and what the index did
 * not know. Not an eval: no expected answers, no baseline; it finds errors,
 * withheld answers, and names the verifier could not place.
 */
export interface UatPack {
  version: number
  areas: Array<{ area: string; questions: string[] }>
}

export interface UatQuestion {
  area: string
  question: string
}

export interface UatCase extends UatQuestion {
  runState: string
  bin: string | null
  streamed: boolean
  citations: number
  verifiedCitations: number
  verification: {
    verified: number
    unverified: number
    dependency: number
    uncited: number
    /** In the commit's files, not modelled by the index: never makes a turn unverified. */
    notCheckable?: number
  }
  /** Names the verifier reported as not in the repository: index gaps to look at, or hallucinations. */
  unverifiedEntities: string[]
  withheldBy: string | null
  notices: string[]
  /** Deterministic views the turn rendered; an index-only answer has one and no citations. */
  views?: string[]
  /** Output rules the gateway ended the answer on: `output.url`, `output.canary`. */
  policies: string[]
  /** What the answer cited, for the labelled expectations (R-08) to score. */
  citedPaths: string[]
  citedSymbols: string[]
  /** Recall of what a person expected, once labelled; absent for an unlabelled scaffold. */
  expectation?: {
    paths: { expected: number; cited: number; missing: string[] }
    symbols: { expected: number; cited: number; missing: string[] }
    recall: number
  }
  ms: number
  error: { code: string; hash: string } | null
}

/**
 * Expected citations per question, labelled by a person (R-08): the runner
 * scaffolds the file with every question and empty expectations and stops;
 * once `labelled_by` is set, each answer is scored by the recall of the
 * expected paths and symbols among what it cited.
 */
export interface UatExpectations {
  version: 1
  repository: string
  labelled_by: string | null
  labelled_at: string | null
  questions: Array<UatQuestion & { expectedPaths: string[]; expectedSymbols: string[] }>
}

/** Below this recall of the labelled expectations, an answer missed what a person expected. */
export const EXPECTATION_RECALL_FLOOR = 0.5

export function scaffoldExpectations(repository: string, cases: UatQuestion[]): UatExpectations {
  return {
    version: 1,
    repository,
    labelled_by: null,
    labelled_at: null,
    questions: cases.map((c) => ({
      area: c.area,
      question: c.question,
      expectedPaths: [],
      expectedSymbols: [],
    })),
  }
}

export function scoreExpectations(cases: UatCase[], expected: UatExpectations): UatCase[] {
  if (!expected.labelled_by) return cases
  const byQuestion = new Map(expected.questions.map((q) => [`${q.area}\n${q.question}`, q]))
  return cases.map((c) => {
    const q = byQuestion.get(`${c.area}\n${c.question}`)
    if (!q || (q.expectedPaths.length === 0 && q.expectedSymbols.length === 0)) return c
    const citedPaths = new Set(c.citedPaths)
    const citedSymbols = new Set(c.citedSymbols.map((s) => s.toLowerCase()))
    const missingPaths = q.expectedPaths.filter((p) => !citedPaths.has(p))
    const missingSymbols = q.expectedSymbols.filter((sym) => !citedSymbols.has(sym.toLowerCase()))
    const expectedCount = q.expectedPaths.length + q.expectedSymbols.length
    const hit = expectedCount - missingPaths.length - missingSymbols.length
    return {
      ...c,
      expectation: {
        paths: {
          expected: q.expectedPaths.length,
          cited: q.expectedPaths.length - missingPaths.length,
          missing: missingPaths,
        },
        symbols: {
          expected: q.expectedSymbols.length,
          cited: q.expectedSymbols.length - missingSymbols.length,
          missing: missingSymbols,
        },
        recall: expectedCount ? hit / expectedCount : 1,
      },
    }
  })
}

export type UatClass =
  | 'ok'
  | 'failed'
  | 'withheld'
  | 'unverified'
  | 'uncited'
  | 'blocked'
  /** A labelled expectation the answer did not meet (recall below the floor). */
  | 'missed'

const PLACEHOLDER = /\{([a-zA-Z]+)\}/g

/** The pack's questions with `{name}` placeholders filled from the parameters; unresolved ones are skipped and named. */
export function expandQuestions(
  pack: UatPack,
  params: Record<string, string>
): {
  questions: UatQuestion[]
  skipped: Array<UatQuestion & { missing: string[] }>
} {
  const questions: UatQuestion[] = []
  const skipped: Array<UatQuestion & { missing: string[] }> = []
  for (const { area, questions: list } of pack.areas)
    for (const template of list) {
      const missing = [...template.matchAll(PLACEHOLDER)]
        .map((m) => m[1])
        .filter((name) => !(name in params))
      if (missing.length) {
        skipped.push({ area, question: template, missing: [...new Set(missing)] })
        continue
      }
      questions.push({ area, question: template.replace(PLACEHOLDER, (_, name) => params[name]) })
    }
  return { questions, skipped }
}

/**
 * One verification event into a case's counts. Names not in the repository are index gaps or
 * hallucinations; a false absence claim is a wrong answer, never a gap.
 */
export function countVerification(
  event: Extract<AnswerEvent, { type: 'verification' }>,
  verification: UatCase['verification'],
  unverifiedEntities: string[]
): void {
  if (event.status === 'unverified' && event.detail.startsWith('not in repository: ')) {
    verification.unverified++
    for (const name of event.detail.slice('not in repository: '.length).split(', '))
      if (name.trim()) unverifiedEntities.push(name.trim())
  } else if (
    event.status === 'unverified' &&
    (event.detail.startsWith('claimed absent, but found: ') ||
      event.detail.startsWith('described without its code: '))
  )
    verification.unverified++
  else if (event.status === 'unverified') verification.uncited++
  else if (event.status === 'not_checkable')
    verification.notCheckable = (verification.notCheckable ?? 0) + 1
  else verification[event.status]++
}

const ANSWER_NOTICES = new Set(['no_instance', 'absence', 'not_found'])
/** Views the index answers with on its own, without model text to cite. */
const ANSWER_VIEWS = new Set(['dependency_graph', 'endpoint_table', 'usage_table'])

export function classify(c: UatCase): UatClass {
  if (c.runState !== 'completed' || c.error) return 'failed'
  if (c.policies.length > 0) return 'blocked'
  if (c.expectation && c.expectation.recall < EXPECTATION_RECALL_FLOOR) return 'missed'
  if (c.withheldBy) return 'withheld'
  if (c.verification.unverified > 0) return 'unverified'
  if (
    c.citations === 0 &&
    !c.notices.some((n) => ANSWER_NOTICES.has(n)) &&
    !(c.views ?? []).some((v) => ANSWER_VIEWS.has(v))
  )
    return 'uncited'
  return 'ok'
}

export interface UatSummary {
  counts: Record<UatClass, number>
  indexGaps: string[]
  failures: Array<{ area: string; question: string; code: string; hash: string }>
  hasErrors: boolean
}

export function summarise(cases: UatCase[]): UatSummary {
  const counts: Record<UatClass, number> = {
    ok: 0,
    failed: 0,
    withheld: 0,
    unverified: 0,
    uncited: 0,
    blocked: 0,
    missed: 0,
  }
  const gaps = new Set<string>()
  const failures: UatSummary['failures'] = []
  for (const c of cases) {
    counts[classify(c)]++
    for (const e of c.unverifiedEntities) gaps.add(e)
    if (c.error)
      failures.push({ area: c.area, question: c.question, code: c.error.code, hash: c.error.hash })
    else if (c.runState !== 'completed')
      failures.push({
        area: c.area,
        question: c.question,
        code: 'E_TURN_' + c.runState.toUpperCase(),
        hash: '',
      })
  }
  return { counts, indexGaps: [...gaps].sort(), failures, hasErrors: counts.failed > 0 }
}

export interface UatRun {
  repository: string
  commit: string
  model: string
  at: string
  /** What produced the answers: the configuration hash and the system prompt's. */
  configHash: string
  promptHash: string
  cases: UatCase[]
  skipped: Array<UatQuestion & { missing: string[] }>
  summary: UatSummary
}

/** Asks every question in order; each turn is its own thread. */
export async function runUat(
  questions: UatQuestion[],
  scope: Scope,
  repository: { id: string; name: string; activeCommitId: string },
  deps: TurnDeps = {},
  onCase: (c: UatCase) => void = () => {},
  /** Every event of every turn, for diagnosis (`uat:run --dump`); never part of the run file. */
  onEvent: (question: string, event: AnswerEvent) => void = () => {}
): Promise<UatCase[]> {
  const cases: UatCase[] = []
  for (const { area, question } of questions) {
    const started = Date.now()
    const citations: Array<Extract<AnswerEvent, { type: 'citation' }>> = []
    const verification = { verified: 0, unverified: 0, dependency: 0, uncited: 0, notCheckable: 0 }
    const unverifiedEntities: string[] = []
    const notices: string[] = []
    const views: string[] = []
    const policies: string[] = []
    let runState = 'failed'
    let bin: string | null = null
    let streamed = false
    let gate: EvidenceGate | null = null
    let error: UatCase['error'] = null
    const untap = securityEvents.tap((record) => {
      if (record.event === 'error.unhandled')
        error = { code: String(record.fields.errorCode), hash: String(record.fields.errorHash) }
    })
    try {
      for await (const event of answerTurn(
        { scope, repository, question },
        new AbortController().signal,
        {
          ...deps,
          onGate: (g) => {
            deps.onGate?.(g)
            gate = g
          },
        }
      )) {
        onEvent(question, event)
        if (event.type === 'status') {
          runState = event.runState
          if (event.label.startsWith('scope:')) bin = event.label.slice('scope:'.length)
        } else if (event.type === 'text' || event.type === 'background')
          streamed ||= event.delta.length > 0
        else if (event.type === 'citation') citations.push(event)
        else if (event.type === 'verification')
          countVerification(event, verification, unverifiedEntities)
        else if (event.type === 'view' && event.component === 'scope_notice')
          notices.push(String((event.data as { kind: string }).kind))
        else if (event.type === 'view') views.push(event.component)
        else if (event.type === 'policy' && event.action === 'blocked') policies.push(event.rule)
      }
    } catch (thrown) {
      error ??= {
        code: String((thrown as { code?: string }).code ?? 'E_THROWN'),
        hash: '',
      }
    } finally {
      untap()
    }
    const verifiedCitations = await verifyCitations(scope, citations)
    const c: UatCase = {
      area,
      question,
      runState,
      bin,
      streamed,
      citations: citations.length,
      verifiedCitations,
      verification,
      unverifiedEntities: [...new Set(unverifiedEntities)],
      withheldBy: (gate as EvidenceGate | null)?.outcome.withheldBy ?? null,
      notices,
      views,
      policies,
      citedPaths: [...new Set(citations.map((x) => x.symbol.path))],
      citedSymbols: [...new Set(citations.map((x) => x.symbol.qualifiedName))],
      ms: Date.now() - started,
      error,
    }
    cases.push(c)
    onCase(c)
  }
  return cases
}

const CLASS_MARK: Record<UatClass, string> = {
  ok: '✔',
  failed: '✖ failed',
  withheld: '⊘ withheld',
  unverified: '? unverified',
  uncited: '· uncited',
  blocked: '⛔ blocked',
  missed: '✗ missed expectation',
}

export function renderUatTable(run: UatRun): string {
  const lines = [
    '| area | question | result | bin | citations (verified) | verification v/u/d/uncited/nc | withheld | notices | ms |',
    '|---|---|---|---|---|---|---|---|---|',
    ...run.cases.map(
      (c) =>
        `| ${c.area} | ${c.question} | ${CLASS_MARK[classify(c)]} | ${c.bin ?? ''} | ${c.citations} (${c.verifiedCitations}) | ${c.verification.verified}/${c.verification.unverified}/${c.verification.dependency}/${c.verification.uncited}/${c.verification.notCheckable ?? 0} | ${c.withheldBy ?? ''} | ${c.notices.join(' ')} | ${c.ms} |`
    ),
  ]
  const s = run.summary
  lines.push(
    '',
    `ok ${s.counts.ok} · failed ${s.counts.failed} · missed ${s.counts.missed} · blocked ${s.counts.blocked} · withheld ${s.counts.withheld} · unverified ${s.counts.unverified} · uncited ${s.counts.uncited} · skipped ${run.skipped.length}`
  )
  if (s.indexGaps.length)
    lines.push(
      `names the verifier could not place (index gaps or hallucinations): ${s.indexGaps.join(', ')}`
    )
  for (const f of s.failures) lines.push(`failed: [${f.area}] ${f.question} → ${f.code} ${f.hash}`)
  for (const q of run.skipped) lines.push(`skipped (needs ${q.missing.join(', ')}): ${q.question}`)
  return lines.join('\n')
}
