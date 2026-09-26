import { configHash } from '#app/audit/config_hash'
import { PROMPTS } from '#app/assistant/prompts/index'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { answerTurn, type TurnDeps } from '#app/assistant/turn_service'
import type { AnswerEvent } from '#app/assistant/protocol'
import { inScope, type Scope } from '#app/security/scope'

/**
 * The smoke run (AC-WP06-09, AC-WP06-15): each human-written question is
 * answered end to end; the record keeps whether the answer streamed, how
 * many citations verified against blob content, time to first released
 * token, and the gate's budget demand for calibration.
 */
export interface SmokeSet {
  fixture: string
  commit: string
  labelled_by: string | null
  questions: string[]
}

export interface SmokeCase {
  question: string
  streamed: boolean
  citations: number
  verifiedCitations: number
  ttftMs: number | null
  runState: string
  endedWith: string
  demand: { connectiveSentences: number; backgroundTokens: number }
  /** What removed the last evidence when text was withheld (BL-00); null when nothing was. */
  withheldBy?: string | null
  /** The bin the orchestrator announced (`scope:<bin>` status), when it did. */
  bin?: string
  /** The notice kinds rendered, in order: what the user saw instead of, or beside, the answer. */
  notices?: string[]
}

export interface SmokeRun {
  fixture: string
  commit: string
  model: string
  at: string
  /** What produced the answers: the configuration hash and the system prompt's. */
  configHash: string
  promptHash: string
  cases: SmokeCase[]
  ttft: { p50: number | null; p95: number | null }
}

export async function loadSmokeSet(
  path = 'evals/cases/smoke/node-express-shop.json'
): Promise<SmokeSet> {
  return JSON.parse(await readFile(path, 'utf8')) as SmokeSet
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((x, y) => x - y)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

export function passed(c: SmokeCase): boolean {
  return c.streamed && c.verifiedCitations > 0
}

/** With `previous`, only cases that failed before are answered again; passing cases are kept. */
export async function runSmoke(
  set: SmokeSet,
  scope: Scope,
  repository: { id: string; name: string; activeCommitId: string },
  model: string,
  deps: TurnDeps = {},
  previous?: SmokeRun
): Promise<SmokeRun> {
  const kept = new Map(
    (previous?.commit === set.commit ? previous.cases : [])
      .filter(passed)
      .map((c) => [c.question, c])
  )
  const cases: SmokeCase[] = []
  for (const question of set.questions) {
    const earlier = kept.get(question)
    if (earlier) {
      cases.push(earlier)
      continue
    }
    const started = Date.now()
    let firstText: number | null = null
    let runState = 'failed'
    let endedWith = ''
    const citations: Array<Extract<AnswerEvent, { type: 'citation' }>> = []
    let demand = { connectiveSentences: 0, backgroundTokens: 0 }
    let withheldBy: string | null = null
    let bin: string | undefined
    const notices: string[] = []
    const gate = {
      current: null as null | { outcome: { demand: typeof demand; withheldBy: string | null } },
    }
    for await (const event of answerTurn(
      { scope, repository, question },
      new AbortController().signal,
      { ...deps, onGate: (g) => (gate.current = g) }
    )) {
      if ((event.type === 'text' || event.type === 'background') && firstText === null)
        firstText = Date.now()
      if (event.type === 'citation') citations.push(event)
      if (event.type === 'status') {
        runState = event.runState
        endedWith = event.label
        if (event.label.startsWith('scope:')) bin = event.label.slice(6)
      }
      if (event.type === 'view' && event.component === 'scope_notice')
        notices.push(String((event.data as { kind?: string }).kind))
    }
    if (gate.current) {
      demand = gate.current.outcome.demand
      withheldBy = gate.current.outcome.withheldBy
    }
    const verified = await verifyCitations(scope, citations)
    cases.push({
      question,
      streamed: firstText !== null,
      citations: citations.length,
      verifiedCitations: verified,
      ttftMs: firstText === null ? null : firstText - started,
      runState,
      endedWith,
      demand,
      withheldBy,
      bin,
      notices,
    })
  }
  const ttfts = cases.map((c) => c.ttftMs).filter((t): t is number => t !== null)
  return {
    fixture: set.fixture,
    commit: set.commit,
    model,
    at: new Date().toISOString(),
    configHash: configHash().hash,
    promptHash: PROMPTS.system.sha256,
    cases,
    ttft: { p50: percentile(ttfts, 50), p95: percentile(ttfts, 95) },
  }
}

/** Recomputes each span hash from the stored blob, independently of the hydration path. */
export async function verifyCitations(
  scope: Scope,
  citations: Array<Extract<AnswerEvent, { type: 'citation' }>>
): Promise<number> {
  let verified = 0
  for (const c of citations) {
    const blob = await inScope(scope, (trx) =>
      trx.from('blobs').where('blob_sha', c.blobSha).select('content').first()
    )
    if (!blob?.content) continue
    const lines = String(blob.content)
      .split('\n')
      .slice(c.span.start - 1, c.span.end)
      .join('\n')
    if (createHash('sha256').update(lines).digest('hex') === c.spanSha256) verified++
  }
  return verified
}

export function renderSmokeSummary(run: SmokeRun): string {
  const ok = run.cases.filter(passed).length
  return [
    `## Smoke questions (${run.fixture} @ ${run.commit.slice(0, 7)}, ${run.model})`,
    '',
    `- answers streamed with a verified citation: ${ok}/${run.cases.length}`,
    `- time to first released token: p50 ${run.ttft.p50 ?? 'n/a'} ms, p95 ${run.ttft.p95 ?? 'n/a'} ms`,
    '',
    '| question | streamed | citations (verified) | TTFT ms | state | ended with |',
    '|---|---|---|---|---|---|',
    ...run.cases.map(
      (c) =>
        `| ${c.question} | ${c.streamed} | ${c.citations} (${c.verifiedCitations}) | ${c.ttftMs ?? 'n/a'} | ${c.runState} | ${c.endedWith} |`
    ),
    '',
  ].join('\n')
}

/**
 * Several recorded runs of one set as a rate with a Wilson interval and the
 * demand maxima (owner review 2026-09-14): on a small model anchored-only
 * release is a rate, so budgets and claims come from repeated runs, never a
 * sample of one.
 */
export interface SmokeAggregate {
  runs: number
  questions: number
  citedRate: { rate: number; lower: number; upper: number; n: number }
  streamedRate: { rate: number; lower: number; upper: number; n: number }
  /** Turns answered by the deterministic no_instance notice: an answer, not a refusal. */
  noInstanceRate: { rate: number; lower: number; upper: number; n: number }
  /** Turns that were neither cited nor a no_instance notice: the refusals. */
  refusedRate: { rate: number; lower: number; upper: number; n: number }
  demand: {
    backgroundTokensMax: number
    backgroundTokensP99: number | null
    connectiveSentencesMax: number
    connectiveSentencesP99: number | null
  }
  withheldBy: Record<string, number>
  perQuestion: Array<{ question: string; cited: number; streamed: number }>
}

export function aggregateSmokeRuns(runs: SmokeRun[]): SmokeAggregate {
  const cases = runs.flatMap((r) => r.cases)
  const wilson = (k: number, n: number) => {
    if (n === 0) return { rate: 0, lower: 0, upper: 0, n }
    const z = 1.96
    const p = k / n
    const denom = 1 + (z * z) / n
    const centre = (p + (z * z) / (2 * n)) / denom
    const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
    return { rate: p, lower: Math.max(0, centre - half), upper: Math.min(1, centre + half), n }
  }
  const answered = cases.filter((c) => c.verifiedCitations > 0)
  const noInstance = cases.filter((c) => (c.notices ?? []).includes('no_instance'))
  const bg = answered.map((c) => c.demand.backgroundTokens)
  const conn = answered.map((c) => c.demand.connectiveSentences)
  const withheldBy: Record<string, number> = {}
  for (const c of cases)
    if (c.withheldBy) withheldBy[c.withheldBy] = (withheldBy[c.withheldBy] ?? 0) + 1
  const questions = [...new Set(cases.map((c) => c.question))]
  return {
    runs: runs.length,
    questions: questions.length,
    citedRate: wilson(answered.length, cases.length),
    streamedRate: wilson(cases.filter((c) => c.streamed).length, cases.length),
    noInstanceRate: wilson(noInstance.length, cases.length),
    refusedRate: wilson(
      cases.filter((c) => c.verifiedCitations === 0 && !(c.notices ?? []).includes('no_instance'))
        .length,
      cases.length
    ),
    demand: {
      backgroundTokensMax: Math.max(0, ...bg),
      backgroundTokensP99: percentile(bg, 99),
      connectiveSentencesMax: Math.max(0, ...conn),
      connectiveSentencesP99: percentile(conn, 99),
    },
    withheldBy,
    perQuestion: questions.map((q) => ({
      question: q,
      cited: cases.filter((c) => c.question === q && c.verifiedCitations > 0).length,
      streamed: cases.filter((c) => c.question === q && c.streamed).length,
    })),
  }
}
