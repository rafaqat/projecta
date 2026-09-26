import { useMemo, useState } from 'react'
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  GitCommitHorizontal,
  HelpCircle,
  Info,
  Quote,
  RotateCcw,
  ScrollText,
  Shield,
  XCircle,
} from 'lucide-react'
import type { AnswerEvent, RunState } from '../../../app/assistant/protocol'
import {
  calleePills,
  citedSentences,
  layoutAnswer,
  summariseVerifications,
  type Citation,
  type InlineKind,
  type Verification,
} from '../../../app/assistant/answer_layout'
import { Button } from '~/components/ui/button'
import { AnswerText } from './answer_text'
import { CitationCard } from './citation'
import { RunStateBadge } from './run_state'
import { sourceKey, type Source } from './sources'
import { StructuredView } from './views'

/**
 * One answer = the events of one turn, rendered in order. Text deltas
 * coalesce into segments; each sentence's citation chips and verification
 * mark sit inline at its end (answer_layout.ts); notices, views and policy
 * events render as their own blocks; a footer summarises what was verified.
 * Nothing here is hydrated from model text: snippets and notices arrive from
 * the server.
 */
export interface ScopeNoticeData {
  kind: 'out_of_scope' | 'absence' | 'not_found' | 'decline' | 'error' | 'no_instance'
  text: string
  suggestedQuestions: string[]
  queriesRun?: string[]
  excludedPaths?: string[]
  exclusions?: Array<{ path: string; reason: string }>
  evidenceExamined?: { results: number; files: string[]; modelSearches: number }
  throttled?: boolean
  retryAfterSeconds?: number
  missing?: Record<string, string[]>
}

export interface AnswerProps {
  events: AnswerEvent[]
  onAsk?: (question: string) => void
  onRegenerate?: (invalidEntities: string[]) => void
  regenerated?: boolean
  onDecision?: (turnHandle: string) => void
  /** Thread-wide numbering of citations; absent when rendered outside a thread. */
  /** This answer's place in the thread: sources are keyed by turn and handle (`sourceKey`). */
  turn?: number
  sources?: Map<string, Source>
  activeSource?: string | null
  onOpenSource?: (key: string) => void
  /** Open an uncited declaration's own code in the file pane on the right, no model turn. */
  onOpenDeclaration?: (declaration: { name: string; path: string; line: number }) => void
  /** What the turn cost, from the ledger and the price table; null until the ledger has it. */
  cost?: TurnCostView | null
  /** The repository and commit the answer is pinned to, for the "grounded at" line. */
  grounding?: { repository: string; commitSha: string | null }
  /** How long the turn took, measured in the browser; absent for turns loaded from history. */
  latencyMs?: number | null
  /** The repository's API base, for views that link to a download (WP-21's dependency export). */
  apiBase?: string
}

export interface TurnCostView {
  usd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  calls: number
  priceVersion: string
}

export const formatUsd = (usd: number) =>
  usd >= 0.01 ? `$${usd.toFixed(2)}` : usd > 0 ? `$${usd.toFixed(4)}` : '$0'

const formatLatency = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`

/** A sentence's verification, drawn at its end: what the reader can trust about that sentence. */
/** The names a verification detail is about, joined for a sentence: "a, b and c". */
function namesIn(detail: string): string {
  const names = detail
    .replace(/^[^:]*:\s*/, '')
    .replace(/^uncited claim naming\s*/, '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
  return names.length > 1
    ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    : (names[0] ?? '')
}

/**
 * What a mark means, in the reader's words: whether the sentence was checked, what was found,
 * and what to do about it (owner, 2026-09-17: "described without its code" read as an error).
 */
function describeMark(verification: Verification): {
  Icon: typeof CheckCircle2
  tone: string
  text: string
} {
  const { status, detail } = verification
  const names = namesIn(detail)
  if (status === 'verified' && detail.startsWith('confirmed absent:'))
    return {
      Icon: CheckCircle2,
      tone: 'text-success',
      text: `Checked — ${names} confirmed absent: the whole commit was searched.`,
    }
  if (status === 'verified')
    return {
      Icon: CheckCircle2,
      tone: 'text-success',
      text: `Checked — what this sentence says about ${names} was compared with the cited code.`,
    }
  if (status === 'dependency')
    return {
      Icon: Info,
      tone: 'text-content-muted',
      text: `A dependency’s API — ${names} belong to a locked dependency, not to this repository’s code.`,
    }
  if (status === 'not_checkable')
    return {
      Icon: HelpCircle,
      tone: 'text-warning',
      text: `Not checked — ${names} appear in the commit’s files, but the index does not model them (a template, a config, a string), so this sentence could not be compared with code.`,
    }
  if (detail.startsWith('claimed absent, but found:'))
    return {
      Icon: XCircle,
      tone: 'text-danger',
      text: `Wrong — this sentence says ${names} are absent, but they are in this commit.`,
    }
  if (detail.startsWith('described without its code:'))
    return {
      Icon: AlertCircle,
      tone: 'text-warning',
      text: `Not checked — this sentence describes ${names}, but cites none of their code. Click Explain to read each one from its own code.`,
    }
  if (detail.startsWith('not in repository:'))
    return {
      Icon: XCircle,
      tone: 'text-danger',
      text: `Not found — ${names} are not in this commit. The sentence may be a guess.`,
    }
  return {
    Icon: AlertCircle,
    tone: 'text-warning',
    text: `Not checked — this sentence names ${names} but cites nothing, so it was not compared with code.`,
  }
}

function VerificationMark({
  verification,
  onAsk,
  onOpenDeclaration,
}: {
  verification?: Verification
  onAsk?: (q: string) => void
  onOpenDeclaration?: (declaration: { name: string; path: string; line: number }) => void
}) {
  if (!verification) return null
  const { status, detail } = verification
  // A function described without its body cited: one click gets it from its own code.
  const explain = detail.startsWith('described without its code:')
    ? detail
        .slice('described without its code:'.length)
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
    : []
  const { Icon, tone, text } = describeMark(verification)
  return (
    <>
      <span
        className={`verification-mark ml-0.5 inline-flex align-[-2px] ${tone}`}
        data-verification={status}
        data-sentence={verification.sentenceId}
        title={text}
        aria-label={text}
        role="img"
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      {explain.map((name) => {
        const at = verification.where?.find((w) => w.name === name)
        const file = at ? at.path.slice(at.path.lastIndexOf('/') + 1) : null
        // With a location, a grey box opens the declaration's own code in the file pane on the
        // right — no model turn. Without one (rare), fall back to asking about it.
        if (at)
          return (
            <button
              key={name}
              type="button"
              className="declaration-pill ml-1 inline-flex h-5 items-center gap-1 rounded-[4px] bg-raised px-2 text-[11px] text-content-secondary shadow-[inset_0_0_0_1px_var(--color-border-input)] hover:text-content-primary"
              onClick={() => onOpenDeclaration?.({ name, path: at.path, line: at.line })}
              title={`Open ${name} on the right from its own code (${at.path}:${at.line})`}
              data-open-declaration
            >
              <span className="text-content-primary">{name.split('.').pop()}</span>
              {file ? <span>· {`${file}:${at.line}`}</span> : null}
            </button>
          )
        return (
          <button
            key={name}
            type="button"
            className="explain-pill ml-1 inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] text-content-muted shadow-[inset_0_0_0_1px_var(--color-border-input)] hover:text-content-primary"
            onClick={() => onAsk?.(`What does \`${name}\` do?`)}
            title={`Read ${name} from its own code and explain it`}
            data-explain-pill
          >
            <span>Explain</span>
            <span className="text-content-primary">{name.split('.').pop()}</span>
          </button>
        )
      })}
    </>
  )
}

export function Answer({
  events,
  onAsk,
  onRegenerate,
  regenerated,
  onDecision,
  turn = 0,
  sources,
  activeSource = null,
  onOpenSource = () => undefined,
  onOpenDeclaration = () => undefined,
  cost,
  grounding,
  latencyMs,
  apiBase,
}: AnswerProps) {
  const [showSources, setShowSources] = useState(false)
  const statuses = events.filter(
    (e): e is Extract<AnswerEvent, { type: 'status' }> => e.type === 'status'
  )
  const latest = statuses[statuses.length - 1]
  const runState: RunState = latest?.runState ?? 'running'
  const layout = useMemo(() => layoutAnswer(events), [events])
  const summary = useMemo(
    () => summariseVerifications(layout.verifications.values()),
    [layout.verifications]
  )
  // ADR-0007: the gateway redacts external links to this token. Count them so the footer can say why
  // (the token itself, inline, is the mark; this is the one-line reason). Keep in sync with URL_MASK_TOKEN.
  const maskedLinks = useMemo(
    () =>
      layout.blocks.reduce(
        (n, b) =>
          b.kind === 'text' || b.kind === 'background'
            ? n + (b.text.split('[external link hidden]').length - 1)
            : n,
        0
      ),
    [layout.blocks]
  )
  const cited = useMemo(() => {
    const seen = new Map<string, Citation>()
    for (const c of layout.citations) if (!seen.has(c.handle)) seen.set(c.handle, c)
    return [...seen.values()]
  }, [layout.citations])
  const keyOf = (handle: string) => sourceKey(turn, handle)
  const numberOf = (handle: string) =>
    sources?.get(keyOf(handle))?.n ?? cited.findIndex((c) => c.handle === handle) + 1
  // "calls X" pills: once per answer, on the first chip that has the callee, never the subject.
  const pills = useMemo(() => calleePills(layout), [layout])
  const pillsDrawn = new Set<string>()
  const citationChip = (citation: Citation) => (
    <CitationCard
      key={citation.handle}
      citation={citation}
      n={numberOf(citation.handle)}
      active={activeSource === keyOf(citation.handle)}
      onOpen={(handle) => onOpenSource(keyOf(handle))}
    />
  )
  // The chip's follow-ups, after the sentence's mark (answer_layout places the pills marker there).
  const callsPills = (citation: Citation) =>
    (pillsDrawn.has(citation.handle)
      ? []
      : (pillsDrawn.add(citation.handle), pills.get(citation.handle) ?? [])
    ).map((c) => (
      <button
        key={c.name}
        type="button"
        className="explain-pill ml-1 inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] text-content-muted shadow-[inset_0_0_0_1px_var(--color-border-input)] hover:text-content-primary"
        onClick={() => onAsk?.(`What does \`${c.name}\` do?`)}
        title={`${citation.symbol.qualifiedName} calls ${c.name} (${c.path}:${c.line}); explain it from its own code`}
        data-calls-pill
      >
        <span>calls</span>
        <span className="text-content-primary">{c.name.split('.').pop()}</span>
        <span>· {`${c.path.slice(c.path.lastIndexOf('/') + 1)}:${c.line}`}</span>
      </button>
    ))
  const renderInline = (kind: InlineKind, ref: string) => {
    if (kind === 'verification')
      return (
        <VerificationMark
          verification={layout.verifications.get(ref)}
          onAsk={onAsk}
          onOpenDeclaration={onOpenDeclaration}
        />
      )
    if (kind === 'citations') {
      // A run of three or more sources on one sentence: one chip that opens the first, plus a
      // muted "+N" — every source is numbered in the Sources rail (UAT 2026-09-17).
      const handles = ref.split(',')
      const first = cited.find((c) => c.handle === handles[0])
      if (!first) return null
      return (
        <span className="inline">
          {citationChip(first)}
          <span
            className="citation-more align-[-2px] ml-0.5 text-[10.5px] font-semibold text-content-muted"
            title={`${handles.length} sources; open the rest in the Evidence rail`}
            aria-label={`${handles.length} sources`}
          >
            +{handles.length - 1}
          </span>
        </span>
      )
    }
    const citation = cited.find((c) => c.handle === ref)
    if (!citation) return null
    return kind === 'pills' ? <>{callsPills(citation)}</> : citationChip(citation)
  }
  const commitSha =
    grounding?.commitSha ?? layout.citations.find((c) => c.commitSha)?.commitSha ?? null
  // The footer's legend: each reason present in this answer, what it means and what to do
  // (owner, 2026-09-17: the verifier's words — "described without its code" — read as errors).
  const legend: Array<{
    key: string
    names: string[]
    Icon: typeof CheckCircle2
    tone: string
    bucket: 'checked' | 'not-checked' | 'not-found'
    label: string
    meaning: string
  }> = [
    {
      key: 'cited',
      names: [],
      Icon: Quote,
      tone: 'text-content-secondary',
      bucket: 'checked',
      label: 'Cited',
      meaning:
        'the sentence carries a numbered source you can open; the code it came from is on screen. A sentence that names no function, file or package has nothing further to check.',
    },
    {
      key: 'verified',
      names: summary.verified,
      Icon: CheckCircle2,
      tone: 'text-success',
      bucket: 'checked',
      label: 'Checked',
      meaning: 'what the sentence says was compared with the code it cites.',
    },
    {
      key: 'declared',
      names: summary.declared,
      Icon: CheckCircle2,
      tone: 'text-success',
      bucket: 'checked',
      label: 'Listed as a declaration',
      meaning:
        'the sentence cites no source, but the decision record lists these as declarations of the file, with their lines. What they do was not compared.',
    },
    {
      key: 'confirmed-absent',
      names: summary.confirmedAbsent,
      Icon: CheckCircle2,
      tone: 'text-success',
      bucket: 'checked',
      label: 'Confirmed absent',
      meaning: 'the answer says these are not in the repository; the whole commit was searched.',
    },
    {
      key: 'dependency',
      names: summary.dependency,
      Icon: Info,
      tone: 'text-content-muted',
      bucket: 'checked',
      label: 'A dependency’s API',
      meaning: 'these belong to a locked dependency, not to this repository’s code.',
    },
    {
      key: 'without-code',
      names: summary.withoutCode,
      Icon: AlertCircle,
      tone: 'text-warning',
      bucket: 'not-checked',
      label: 'Described, code not cited',
      meaning:
        'the answer says what these do without citing their code, so that was not checked. Use an Explain pill to read each one from its own code.',
    },
    {
      key: 'uncited',
      names: summary.uncited,
      Icon: AlertCircle,
      tone: 'text-warning',
      bucket: 'not-checked',
      label: 'Named, no source cited',
      meaning:
        'the sentence names these, and neither a citation nor the decision record on screen shows them, so they were not compared with code.',
    },
    {
      key: 'not-checkable',
      names: summary.notCheckable,
      Icon: HelpCircle,
      tone: 'text-warning',
      bucket: 'not-checked',
      label: 'Not modelled by the index',
      meaning:
        'these appear in the commit’s files (a template, a config, a string) but not as code the index can compare against.',
    },
    {
      key: 'not-found',
      names: summary.notFound,
      Icon: XCircle,
      tone: 'text-danger',
      bucket: 'not-found',
      label: 'Not in this commit',
      meaning: 'these names are nowhere in the commit; the sentence may be a guess.',
    },
    {
      key: 'contradicted',
      names: summary.contradicted,
      Icon: XCircle,
      tone: 'text-danger',
      bucket: 'not-found',
      label: 'Claimed absent, but present',
      meaning: 'the answer says these are absent; they are in this commit.',
    },
  ]
  // The first line counts sentences, not names: a reader compares it with the chips they see
  // (UAT 2026-09-17: "3 checked" under eleven sources read as eight sentences unchecked).
  const bucketOf = (v: Verification): (typeof legend)[number]['bucket'] => {
    if (v.status === 'verified' || v.status === 'dependency') return 'checked'
    if (
      v.detail.startsWith('not in repository:') ||
      v.detail.startsWith('claimed absent, but found:')
    )
      return 'not-found'
    return 'not-checked'
  }
  const count = (bucket: (typeof legend)[number]['bucket']) =>
    [...layout.verifications.values()].filter((v) => bucketOf(v) === bucket).length
  const citedCount = citedSentences(layout)
  const buckets: Array<
    [(typeof legend)[number]['bucket'] | 'cited', number, typeof CheckCircle2, string, string]
  > = [
    [
      'cited',
      citedCount,
      Quote,
      'text-content-secondary',
      citedCount === 1 ? 'sentence cited' : 'sentences cited',
    ],
    ['checked', count('checked'), CheckCircle2, 'text-success', 'checked against the code'],
    ['not-checked', count('not-checked'), AlertCircle, 'text-warning', 'not checked'],
    ['not-found', count('not-found'), XCircle, 'text-danger', 'not found'],
  ]
  return (
    <article
      className="answer grid grid-cols-[26px_minmax(0,1fr)] gap-3"
      data-run-id={latest?.runId ?? ''}
      data-run-state={runState}
    >
      <span className="bot grid h-[26px] w-[26px] place-items-center">
        <Bot className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0">
        <header className="answer-header flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold">Assistant</span>
          <span className="badge badge-ai" data-ai-label>
            AI-generated
          </span>
          <RunStateBadge
            state={runState}
            detail={latest && runState === 'running' ? latest.label : undefined}
          />
          {grounding && commitSha ? (
            <span
              className="inline-flex items-center gap-1 text-xs text-content-muted"
              data-grounded
            >
              <GitCommitHorizontal className="h-3.5 w-3.5" />
              Grounded at{' '}
              <code className="mono">
                {grounding.repository}@{commitSha.slice(0, 7)}
              </code>
            </span>
          ) : null}
          <span className="flex-1" />
          {latencyMs ? (
            <span className="mono text-xs text-content-muted" data-latency={latencyMs}>
              {formatLatency(latencyMs)}
            </span>
          ) : null}
          {cost ? (
            <span
              className="mono text-xs text-content-muted"
              data-turn-cost={cost.usd}
              title={`${cost.inputTokens.toLocaleString()} in · ${cost.outputTokens.toLocaleString()} out${cost.cacheReadTokens ? ` · ${cost.cacheReadTokens.toLocaleString()} cached` : ''} · ${cost.calls} call${cost.calls === 1 ? '' : 's'} · prices ${cost.priceVersion}`}
            >
              {formatUsd(cost.usd)}
            </span>
          ) : null}
          {onDecision && latest && runState !== 'running' ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onDecision(latest.runId)}
              data-open-decision
            >
              <ScrollText className="h-3.5 w-3.5" />
              Decision record
            </Button>
          ) : null}
        </header>
        <div className="mt-1.5">
          {layout.blocks.map((block, i) => {
            switch (block.kind) {
              case 'text':
              case 'background':
                return (
                  <AnswerText
                    key={i}
                    text={block.text}
                    kind={block.kind}
                    renderInline={renderInline}
                  />
                )
              case 'citation':
                return (
                  <span key={i}>
                    {citationChip(block.citation)}
                    {callsPills(block.citation)}
                  </span>
                )
              case 'notice':
                return (
                  <ScopeNotice key={i} notice={block.notice as ScopeNoticeData} onAsk={onAsk} />
                )
              case 'view':
                return (
                  <StructuredView
                    key={i}
                    component={block.component}
                    data={block.data}
                    onAsk={onAsk}
                    apiBase={apiBase}
                    turnHandle={latest?.runId}
                  />
                )
              case 'policy':
                return (
                  <p
                    key={i}
                    className="policy my-2 text-xs text-content-muted"
                    data-rule={block.rule}
                  >
                    Policy applied: {block.rule}
                  </p>
                )
              case 'error':
                return (
                  <p key={i} className="error">
                    {block.message}
                  </p>
                )
            }
          })}
        </div>
        {showSources && cited.length > 0 ? (
          <ol className="answer-sources mt-3 rounded-md bg-hover px-3 py-2 text-sm" data-sources>
            {cited.map((c) => (
              <li key={c.handle} className="flex flex-wrap items-baseline gap-x-2 py-0.5">
                <span className="w-5 text-right text-xs text-content-muted">
                  {numberOf(c.handle)}.
                </span>
                <button
                  type="button"
                  className="mono text-left text-primary hover:underline"
                  onClick={() => onOpenSource(keyOf(c.handle))}
                >
                  {c.symbol.path}#L{c.span.start}-L{c.span.end}
                </button>
                {c.symbol.qualifiedName && c.symbol.qualifiedName !== c.symbol.path ? (
                  <span className="text-xs text-content-muted">in {c.symbol.qualifiedName}</span>
                ) : null}
                {c.precision === 'symbol' ? (
                  <span className="badge badge-warn">symbol precision</span>
                ) : null}
                {/* Since a citation can land on a comment. The provenance is true; what
                    a comment says is the repository's prose, not its behaviour, and a planted one
                    would look exactly like this. The reader is told which kind of line it is. */}
                {c.commentOnly ? (
                  <span className="badge badge-warn" data-comment-only>
                    comment, not code
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
        {layout.verifications.size > 0 || cited.length > 0 || maskedLinks > 0 ? (
          <footer
            className="answer-footer mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-2 text-[13px]"
            data-verification-summary
          >
            {maskedLinks > 0 ? (
              <span
                className="inline-flex items-center gap-1 text-content-muted"
                data-masked-links
                data-count={maskedLinks}
                title="External links are never shown; the assistant cites code by file and line (ADR-0007)."
              >
                <Shield className="h-3.5 w-3.5" />
                {maskedLinks} external {maskedLinks === 1 ? 'link' : 'links'} hidden for security
              </span>
            ) : null}
            {buckets.map(([bucket, n, Icon, tone, label]) =>
              n > 0 || bucket === 'cited' ? (
                <span
                  key={bucket}
                  className={`inline-flex items-center gap-1 ${n ? '' : 'text-content-muted'}`}
                  data-bucket={bucket}
                  data-count={n}
                >
                  <Icon className={`h-3.5 w-3.5 ${n ? tone : ''}`} />
                  {n} {label}
                </span>
              ) : null
            )}
            <span className="flex-1" />
            {cited.length > 0 ? (
              <Button
                variant="outline"
                size="sm"
                aria-expanded={showSources}
                onClick={() => setShowSources((v) => !v)}
                data-sources-toggle
              >
                {showSources ? 'Hide sources' : `Sources (${cited.length})`}
              </Button>
            ) : null}
            {summary.notFound.length > 0 && onRegenerate && runState !== 'running' ? (
              <Button
                variant="outline"
                size="sm"
                disabled={regenerated}
                onClick={() => onRegenerate(summary.notFound)}
                data-regenerate
              >
                <RotateCcw className="h-3 w-3" />
                {regenerated ? 'Regenerated once' : 'Regenerate with citations required'}
              </Button>
            ) : null}
            {layout.verifications.size > 0 ? (
              <details className="answer-legend basis-full text-xs" data-legend>
                <summary className="cursor-pointer text-content-muted hover:text-content-primary">
                  What do the marks mean?
                </summary>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {legend.map(({ key, names, Icon, tone, label, meaning }) =>
                    names.length > 0 || key === 'verified' || key === 'cited' ? (
                      <li
                        key={key}
                        className="grid grid-cols-[14px_minmax(0,1fr)] items-start gap-1.5"
                        title={names.join('\n') || undefined}
                        data-summary={key}
                        data-count={names.length}
                      >
                        <Icon className={`mt-0.5 h-3.5 w-3.5 ${names.length ? tone : ''}`} />
                        <span>
                          <span className="font-medium text-content-primary">
                            {label}
                            {key === 'cited'
                              ? ` · ${citedCount}`
                              : names.length
                                ? ` · ${names.length}`
                                : ''}
                          </span>
                          : {meaning}
                          {names.length ? (
                            <span className="mono ml-1 text-content-muted">
                              {names.slice(0, 6).join(', ')}
                              {names.length > 6 ? ', …' : ''}
                            </span>
                          ) : null}
                        </span>
                      </li>
                    ) : null
                  )}
                </ul>
              </details>
            ) : null}
          </footer>
        ) : null}
      </div>
    </article>
  )
}

/** Why a file was left out of the index, in the reader's words (WP-19, BL-23). */
const EXCLUSION_TEXT: Record<string, string> = {
  binary: 'it was read as binary',
  line_too_long: 'a line exceeds the length limit',
  file_too_large: 'it exceeds the size limit',
  unsupported_language: 'its language is not parsed',
  symlink: 'it is a symbolic link',
  submodule: 'it is a submodule',
  canary_collision: 'it carries a value reserved for the system’s own guards',
}

/** Every template renders through this component; its data never comes from model text. */
export function ScopeNotice({
  notice,
  onAsk,
}: {
  notice: ScopeNoticeData
  onAsk?: (q: string) => void
}) {
  return (
    <div className={`scope-notice scope-notice-${notice.kind}`} data-notice={notice.kind}>
      <p>{notice.text}</p>
      {notice.throttled ? (
        <p className="muted" data-throttled>
          The question classifier is paused after repeated out-of-scope questions; it resumes in
          about {Math.max(1, Math.ceil((notice.retryAfterSeconds ?? 60) / 60))} minute(s). Questions
          that name a symbol or file are still answered.
        </p>
      ) : null}
      {notice.evidenceExamined ? (
        <p className="muted" data-evidence-examined>
          Examined {notice.evidenceExamined.results} retrieved span(s) across{' '}
          {notice.evidenceExamined.files.length} file(s)
          {notice.evidenceExamined.files.length
            ? ` (${notice.evidenceExamined.files.join(', ')})`
            : ''}
          ; the assistant ran {notice.evidenceExamined.modelSearches} search(es) of its own
          {notice.evidenceExamined.modelSearches === 0
            ? ' — an absence claimed without searching is weak'
            : ''}
          .
        </p>
      ) : null}
      {notice.queriesRun?.length ? (
        <p className="muted">Queries run: {notice.queriesRun.join(', ')}</p>
      ) : null}
      {notice.excludedPaths?.length ? (
        <p className="muted">Excluded paths: {notice.excludedPaths.join(', ')}</p>
      ) : null}
      {notice.exclusions?.length ? (
        <ul className="muted" data-exclusions>
          {notice.exclusions.map((e) => (
            <li key={e.path} data-exclusion-reason={e.reason}>
              <code>{e.path}</code> was not indexed: {EXCLUSION_TEXT[e.reason] ?? e.reason}
            </li>
          ))}
        </ul>
      ) : null}
      {notice.missing && Object.keys(notice.missing).length ? (
        <ul className="muted">
          {Object.entries(notice.missing).map(([id, close]) => (
            <li key={id}>
              <code>{id}</code>
              {close.length ? (
                <>
                  {' '}
                  — did you mean{' '}
                  {close.map((c) => (
                    <code key={c}>{c}</code>
                  ))}
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {notice.suggestedQuestions.length ? (
        <ul className="suggestions">
          {notice.suggestedQuestions.map((q) => (
            <li key={q}>
              <button type="button" onClick={() => onAsk?.(q)}>
                {q}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
