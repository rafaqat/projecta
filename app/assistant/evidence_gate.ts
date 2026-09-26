import type { AnswerEvent } from '#app/assistant/protocol'
import type { CodeSpan, EntityVerifier } from '#app/assistant/verification'
import { describeWithheld, type WithheldReason } from '#app/assistant/withheld_span'
import type { ScopeNotice } from '#app/retrieval/answer_route'
import { securityEvents } from '#app/security/events/index'

/**
 * The evidence gate (INV-22): the boundary between any
 * Orchestrator implementation and the single SSE encoder. Model-authored
 * text is held sentence by sentence until the turn has evidence (a hydrated
 * citation or a deterministic view); uncited sentences and background are
 * released only within calibrated budgets; a turn that ends without
 * evidence releases no model text and renders a template instead. Any error
 * inside the gate withholds the whole answer.
 */
/** The file and lines a citation event shows. */
function spanOf(event: AnswerEvent): CodeSpan {
  const c = event as { symbol: { path: string }; span: { start: number; end: number } }
  return { path: c.symbol.path, start: c.span.start, end: c.span.end }
}

export interface GateBudgets {
  /** Uncited, non-background sentences allowed per answer. */
  connectiveSentences: number
  /** Whitespace-delimited tokens of <general> text allowed per answer. */
  backgroundTokens: number
}

export interface GateContext {
  budgets: GateBudgets
  /** Budgets for an anchored-only turn (WP-19, BL-12); the orchestrator names the bin with a `scope:<bin>` status. */
  anchoredOnlyBudgets?: GateBudgets
  templates: {
    absence: string
    outOfScope: string
    decline: string
    /** Uncited text beyond the connective or background budget. */
    withheld: string
    /** An unshown answer made only of confirmed absences. */
    noInstance: string
    error: string
  }
  repository: string
  commitSha: string
  suggestedQuestions: string[]
  verifier?: EntityVerifier
  /**
   * True when an uncited sentence reproduces a comment from the evidence verbatim
   * (app/assistant/quoted_comment.ts): withheld as `quoted_comment`, the shape of a model
   * echoing an instruction planted in a comment (live baseline 2026-09-18, rt-003). Absent under
   * the `no_quoted_comment_rule` ablation. Cited sentences are never asked.
   */
  quotedComment?: (sentence: string) => boolean
  /** Test seam: throws inside the gate (fault injection, AC-WP06-14). */
  fault?: () => void
}

/**
 * The mechanism that removed the last piece of evidence when the gate
 * withheld (WP-19, BL-00). A false positive anywhere upstream otherwise
 * reaches the user as a well-formed absence message that nothing names.
 */
export type WithheldBy =
  | 'retrieval_insufficient'
  | 'no_citation'
  | 'hydration_rejected'
  | 'budget_exhausted'
  /** Every withheld sentence reproduced a comment from the evidence uncited; no budget was hit. */
  | 'quoted_comment'
  | 'gate_error'
  /** The model declared no instance of the concept; the deterministic notice is the answer and its prose is not released. */
  | 'no_instance'

export interface GateOutcome {
  released: string
  withheld: string
  withheldBy: WithheldBy | null
  evidence: boolean
  firstHoldAt: number | null
  firstReleaseAt: number | null
  /** What the answer asked for, before caps: the input to budget calibration. */
  demand: { connectiveSentences: number; backgroundTokens: number }
}

// A terminator followed by whitespace, or a newline. Not the end of the buffer: text arrives
// in deltas, and a delta that ends in the dot of `sessionCheck.isAdminExist` is not a sentence
// end (the last, unterminated sentence is flushed by finish()).
const SENTENCE_END = /[.!?](?=\s)|\n/
/**
 * Structure, not a sentence: a list number or bullet, a heading line, an emphasis marker. Such
 * a piece is never cut off on its own (it would count as an uncited sentence: "explain each
 * API", UAT 2026-09-17, 15 entry numbers ate the connective budget); it stays with the sentence
 * that follows it.
 */
const STRUCTURE_ONLY = /^\s*(?:(?:\d+[.)]|[-*+•]|#{1,6}\s[^\n]*|\*\*[^*\n]*\*\*:?|---)\s*)+$/

/** The next sentence end at or after `from`, as a match on the whole text. */
function nextEnd(text: string, from: number): RegExpExecArray | null {
  const m = SENTENCE_END.exec(text.slice(from))
  if (!m) return null
  m.index += from
  return m
}

/**
 * A completed sentence (or a background segment) waiting for release. Its citations travel with
 * it and are emitted right after its text, so the reader sees each citation beside the sentence it
 * supports; the provider sends them before the gate releases the text.
 */
interface HeldItem {
  kind: 'text' | 'background'
  text: string
  cited: boolean
  citations: AnswerEvent[]
  /** The provider's content blocks the text came from: a citation names the block it cites. */
  blocks: Set<number>
  released?: boolean
}

/** A sentence being written: its text so far, and the citations that arrived for it. */
interface Current {
  text: string
  cited: boolean
  citations: AnswerEvent[]
  blocks: Set<number>
}

const fresh = (): Current => ({ text: '', cited: false, citations: [], blocks: new Set() })

export class EvidenceGate {
  readonly outcome: GateOutcome = {
    released: '',
    withheld: '',
    withheldBy: null,
    evidence: false,
    firstHoldAt: null,
    firstReleaseAt: null,
    demand: { connectiveSentences: 0, backgroundTokens: 0 },
  }
  private held: HeldItem[] = []
  private current: Current = fresh()
  /** The most recent completed sentence: native citations arrive after the text they cite. */
  private last: { item: HeldItem; releasedAsConnective: boolean } | null = null
  /**
   * The citations of the last released cited sentence and the text released since: an
   * uncited sentence in the same paragraph may be verified by the code they show.
   */
  private support: { item: HeldItem | null; snippets: string[]; spans: CodeSpan[]; gap: string } = {
    item: null,
    snippets: [],
    spans: [],
    gap: '',
  }
  private connectiveUsed = 0
  /** A budget (not only a quoted comment) withheld something: names the mechanism at the end. */
  private budgetWithheld = false
  private backgroundUsed = 0
  private declined = false
  private withheldNoticed = false
  /** The run of withheld text being collected, marked at its place when it ends. */
  private run: {
    reason: WithheldReason
    text: string
    sentences: number
    used: number
    limit: number
  } | null = null
  private retrievalInsufficient = false
  private hydrationRejected = false
  private noInstance = false
  /** The scope bin, from the orchestrator's `scope:<bin>` status; templates key on it (BL-08). */
  private bin: 'in_scope' | 'anchored_only' = 'in_scope'
  /** Routing anchored the question on a name the index has: it is in scope whatever the model cites (BL-08). */
  private anchored = false
  private checking = false
  private sentenceSeq = 0

  private budgets: GateBudgets

  constructor(private readonly ctx: GateContext) {
    this.budgets = ctx.budgets
  }

  async *apply(stream: AsyncIterable<AnswerEvent>): AsyncIterable<AnswerEvent> {
    let runId = ''
    try {
      for await (const event of stream) {
        this.ctx.fault?.()
        switch (event.type) {
          case 'status':
            runId = event.runId
            if (event.label === 'scope:anchored') this.anchored = true
            if (event.label === 'scope:anchored_only') {
              this.bin = 'anchored_only'
              if (this.ctx.anchoredOnlyBudgets) this.budgets = this.ctx.anchoredOnlyBudgets
            }
            if (event.label.startsWith('retrieval:'))
              this.retrievalInsufficient = event.label.endsWith('insufficient_evidence')
            if (event.runState !== 'running') {
              yield* this.finish(event)
              return
            }
            yield event
            break
          case 'citation': {
            // A citation cites the whole text of its content block, and the provider may send it
            // before that text or after it. It goes to the sentence being written when that holds
            // text of the block, or when the block's text has not arrived yet (it is the next
            // sentence: UAT 2026-09-17, every sentence carried the next one's citation); to the
            // sentence just completed when that holds the block's text; without a block number,
            // at a boundary to the sentence just completed, mid-sentence to the one being written.
            const { block, ...rest } = event
            const cited = rest as AnswerEvent
            const written = this.current.text.trim() !== ''
            const toLast =
              this.last !== null &&
              (block === undefined
                ? !written
                : !this.current.blocks.has(block) && this.last.item.blocks.has(block))
            if (toLast && this.last) {
              if (!this.last.item.cited) {
                this.last.item.cited = true
                if (this.last.releasedAsConnective) {
                  // Refund the slot, and the demand it was counted as: it was a cited claim.
                  this.connectiveUsed--
                  this.outcome.demand.connectiveSentences--
                  this.last.releasedAsConnective = false
                }
              }
              if (this.last.item.released) {
                if (this.support.item === this.last.item) {
                  this.support.snippets.push((cited as { snippet: string }).snippet)
                  this.support.spans.push(spanOf(cited))
                }
                yield cited // already on screen: follow it directly
              } else this.last.item.citations.push(cited)
            } else {
              this.current.cited = true
              this.current.citations.push(cited)
            }
            yield* this.becameEvidence()
            break
          }
          case 'policy':
            if (event.rule.startsWith('citation.unresolvable_handle')) this.hydrationRejected = true
            yield event
            break
          case 'view':
            if (isNotice(event)) {
              const kind = (event.data as ScopeNotice).kind
              if (kind === 'decline') {
                if (!this.declined) {
                  this.declined = true
                  yield event
                }
                break
              }
              if (kind === 'no_instance') this.noInstance = true
              yield event // out_of_scope / not_found / absence / no_instance templates pass; they are not evidence
              break
            }
            yield event
            yield* this.becameEvidence()
            break
          case 'text':
            yield* this.onText(event.delta, 'text', runId, event.block)
            break
          case 'background':
            yield* this.onText(event.delta, 'background', runId)
            break
          default:
            yield event
        }
      }
    } catch {
      // Fail closed (INV-07, INV-22): nothing held is released, the answer is replaced by the error template.
      this.outcome.withheld += this.held.map((h) => h.text).join('') + this.current.text
      this.outcome.withheldBy = 'gate_error'
      // Citations already received are still recorded; only text is withheld.
      const pending = [...this.held.flatMap((h) => h.citations), ...this.current.citations]
      this.held = []
      yield* pending
      securityEvents.emit('policy.enforced', { rule: 'evidence_gate.error', decision: 'withheld' })
      yield { type: 'policy', rule: 'evidence_gate.error', action: 'blocked' }
      yield this.notice('error', this.ctx.templates.error)
      yield { type: 'status', label: 'withheld', runId, runState: 'failed' }
    }
  }

  private *onText(
    delta: string,
    kind: 'text' | 'background',
    runId: string,
    block?: number
  ): Generator<AnswerEvent> {
    if (!this.checking && !this.outcome.evidence) {
      this.checking = true
      this.outcome.firstHoldAt = Date.now()
      yield { type: 'status', label: 'checking evidence', runId, runState: 'running' }
    }
    if (kind === 'background') {
      // Background is atomic per segment: it never carries a citation.
      this.held.push({ kind, text: delta, cited: false, citations: [], blocks: new Set() })
    } else {
      this.current.text += delta
      // An empty delta is the one the provider pairs with a citation: it holds no text of the block.
      if (block !== undefined && delta !== '') this.current.blocks.add(block)
      let from = 0
      let end = nextEnd(this.current.text, from)
      while (end && !insideFence(this.current.text, end.index)) {
        const cut = end.index + end[0].length
        if (STRUCTURE_ONLY.test(this.current.text.slice(0, cut))) {
          // Keep looking past the structure for the sentence it introduces.
          from = cut
          end = nextEnd(this.current.text, from)
          continue
        }
        const text = this.current.text.slice(0, cut)
        const rest = this.current.text.slice(cut)
        // Whitespace is never a sentence: it is not "the sentence just completed" (a citation
        // arriving after a paragraph break belongs to the sentence before it, UAT 2026-09-17:
        // entries lost their citations), and it keeps no citation that arrived ahead of the
        // sentence it introduces (the same day: a block's citations came before its text).
        const blank = text.trim() === ''
        const item: HeldItem = {
          kind: 'text',
          text,
          cited: blank ? false : this.current.cited,
          citations: blank ? [] : this.current.citations,
          blocks: this.current.blocks,
        }
        this.held.push(item)
        if (!blank) this.last = { item, releasedAsConnective: false }
        this.current = {
          text: rest,
          cited: blank ? this.current.cited : false,
          citations: blank ? this.current.citations : [],
          // The text after the cut came from the delta that ended the sentence.
          blocks: new Set(rest && block !== undefined ? [block] : []),
        }
        from = 0
        end = nextEnd(this.current.text, from)
      }
    }
    // A sentence that ended exactly where the delta ended may still be cited by the citation
    // the model sends next (the provider delivers a text delta and its citations together):
    // it waits for the next event instead of going out as a connective (2026-09-16: with a
    // view already in evidence, the first sentence was released uncited a moment before its
    // citation arrived).
    // The last uncited sentence also waits while the next sentence has no citation yet and the
    // paragraph is open: that citation may support it.
    if (this.outcome.evidence) yield* this.flush(this.current.citations.length === 0)
  }

  /**
   * The citations already attached to the sentence being written, when it is the next sentence
   * of `item`'s paragraph: no other sentence between them, no blank line.
   */
  private forwardSupport(
    item: HeldItem,
    pending: HeldItem[]
  ): { snippets: string[]; spans: CodeSpan[] } {
    const none = { snippets: [], spans: [] }
    if (this.current.citations.length === 0) return none
    const after = pending.slice(pending.indexOf(item) + 1)
    if (after.some((w) => w.kind !== 'text' || w.text.trim() !== '')) return none
    const gap = after.map((w) => w.text).join('') + this.current.text.match(/^\s*/)![0]
    if (/\n\s*\n/.test(gap)) return none
    return {
      snippets: this.current.citations.map((c) => (c as { snippet: string }).snippet),
      spans: this.current.citations.map(spanOf),
    }
  }

  private *becameEvidence(): Generator<AnswerEvent> {
    if (!this.outcome.evidence) this.outcome.evidence = true
    yield* this.flush()
  }

  /** Releases held sentences under the budgets; the current (unfinished) sentence waits, and so does the last completed one when `keepLast` (a citation may follow). */
  private *flush(keepLast = false): Generator<AnswerEvent> {
    const pending = this.held
    this.held = []
    if (keepLast && pending.length > 0) {
      // The last sentence, with the whitespace after it: a paragraph break may precede its
      // citation, and the next sentence's citation may support it — unless a blank line
      // has already closed its paragraph.
      let at = pending.length
      while (at > 0 && pending[at - 1].kind === 'text' && pending[at - 1].text.trim() === '') at--
      const last = pending[at - 1]
      const after = pending
        .slice(at)
        .map((w) => w.text)
        .join('')
      // Closed only once the next sentence has begun on the far side of a blank line: until text
      // arrives, the citation that follows may still be this sentence's own (the provider sends it
      // after the text, sometimes after the break).
      const closed =
        this.current.text.trim() !== '' &&
        /\n\s*\n/.test(after + this.current.text.match(/^\s*/)![0])
      if (last && last.kind === 'text' && !last.cited && !closed) this.held = pending.splice(at - 1)
    }
    for (const item of pending) {
      if (item.kind === 'background') {
        const tokens = item.text.split(/\s+/).filter(Boolean).length
        this.outcome.demand.backgroundTokens += tokens
        if (this.backgroundUsed + tokens <= this.budgets.backgroundTokens) {
          yield* this.closeRun()
          this.backgroundUsed += tokens
          item.released = true
          this.support = { item: null, snippets: [], spans: [], gap: '' } // background ends a paragraph's support
          yield* this.release({ type: 'background', delta: item.text })
        } else {
          yield* this.withhold(item.text, 'background_budget')
        }
        continue
      }
      if (item.text.trim() === '' && this.run) {
        // Whitespace between withheld sentences belongs to the run, never to the screen.
        this.run.text += item.text
        this.outcome.withheld += item.text
        yield* item.citations
        continue
      }
      if (item.text.trim() === '') {
        item.released = true
        this.support.gap += item.text
        yield* this.release({ type: 'text', delta: item.text }) // whitespace is not a sentence
        yield* item.citations
        continue
      }
      const sentenceId = `s${++this.sentenceSeq}`
      if (item.cited) {
        yield* this.closeRun()
        item.released = true
        this.support = {
          item,
          snippets: item.citations.map((c) => (c as { snippet: string }).snippet),
          spans: item.citations.map(spanOf),
          gap: '',
        }
        yield* this.release({ type: 'text', delta: item.text })
        yield* item.citations
        // Its own cited code checks the names the index does not model.
        yield* this.ctx.verifier?.verify(
          sentenceId,
          item.text,
          true,
          this.support.snippets,
          this.support.spans
        ) ?? []
      } else if (this.ctx.quotedComment?.(item.text)) {
        // Uncited words lifted from a comment: not connective prose, and not charged to its budget.
        yield* this.withhold(item.text, 'quoted_comment')
        yield* item.citations
      } else if (this.connectiveUsed < this.budgets.connectiveSentences) {
        this.outcome.demand.connectiveSentences++
        yield* this.closeRun()
        this.connectiveUsed++
        if (this.last?.item === item) this.last.releasedAsConnective = true
        item.released = true
        // Support holds only within the paragraph of the sentence that cited it — and
        // comes forward from the next sentence's citation in the same paragraph.
        const inParagraph = this.support.item && !/\n\s*\n/.test(this.support.gap)
        const forward = this.forwardSupport(item, pending)
        const snippets = [...(inParagraph ? this.support.snippets : []), ...forward.snippets]
        const spans = [...(inParagraph ? this.support.spans : []), ...forward.spans]
        this.support.gap += item.text
        yield* this.release({ type: 'text', delta: item.text })
        yield* item.citations
        yield* this.ctx.verifier?.verify(sentenceId, item.text, false, snippets, spans) ?? []
      } else {
        this.outcome.demand.connectiveSentences++
        yield* this.withhold(item.text, 'connective_budget')
        yield* item.citations // a withheld sentence is uncited; kept so no citation is ever dropped
      }
    }
  }

  private *release(
    event: Extract<AnswerEvent, { type: 'text' | 'background' }>
  ): Generator<AnswerEvent> {
    this.outcome.firstReleaseAt ??= Date.now()
    this.outcome.released += event.delta
    yield event
  }

  /** Collects withheld text into the current run; the run is marked where it ends. */
  private *withhold(text: string, reason: WithheldReason): Generator<AnswerEvent> {
    this.outcome.withheld += text
    this.withheldNoticed = true
    if (reason !== 'quoted_comment') this.budgetWithheld = true
    if (this.run && this.run.reason !== reason) yield* this.closeRun()
    this.run ??= {
      reason,
      text: '',
      sentences: 0,
      used: reason === 'background_budget' ? this.backgroundUsed : this.connectiveUsed,
      limit:
        reason === 'background_budget'
          ? this.budgets.backgroundTokens
          : this.budgets.connectiveSentences,
    }
    this.run.text += text
    this.run.sentences++
  }

  /** Marks the ended run at its place: how much, why, what it named, and what to ask. */
  private *closeRun(): Generator<AnswerEvent> {
    const run = this.run
    if (!run) return
    this.run = null
    const verifier = this.ctx.verifier
    yield {
      type: 'view',
      component: 'withheld_span',
      data: describeWithheld(
        run.text,
        run.reason,
        run.sentences,
        { used: run.used, limit: run.limit },
        (name) => verifier?.inCommit(name) ?? false
      ),
    }
  }

  private *finish(terminal: Extract<AnswerEvent, { type: 'status' }>): Generator<AnswerEvent> {
    if (this.current.text)
      this.held.push({
        kind: 'text',
        text: this.current.text,
        cited: this.current.cited,
        citations: this.current.citations,
        blocks: this.current.blocks,
      })
    else if (this.current.citations.length) {
      // Citations with no sentence after them: they belong to the last one, or stand alone.
      if (this.last && !this.last.item.released)
        this.last.item.citations.push(...this.current.citations)
      else yield* this.current.citations
    }
    this.current = fresh()
    if (this.outcome.evidence) {
      yield* this.flush()
      yield* this.closeRun()
      if (this.outcome.withheld)
        this.outcome.withheldBy = this.budgetWithheld ? 'budget_exhausted' : 'quoted_comment'
      // One notice for everything withheld, after the answer; each run is marked at its place.
      if (this.withheldNoticed) yield this.notice('decline', this.ctx.templates.withheld)
    } else if (this.held.length > 0 || this.outcome.withheld) {
      // No evidence at turn end: withhold everything, render the template (layer 3),
      // and name what removed the evidence so the withhold can be diagnosed (BL-00).
      const held = this.held
      this.outcome.withheld += held.map((h) => h.text).join('')
      this.held = []
      if (!this.noInstance && this.onlyConfirmedAbsences(held)) {
        // The model wrote its absence as prose, and every code claim in it checks out as absent
        // from the commit: the deterministic notice answers, as <no_instance/> would have.
        this.outcome.withheldBy = 'no_instance'
        yield this.notice(
          'no_instance',
          this.ctx.templates.noInstance
            .replace('{repository}', this.ctx.repository)
            .replace('{commit}', this.ctx.commitSha.slice(0, 7))
        )
      } else if (this.noInstance) {
        // The deterministic notice already answered; the model's prose after it is never shown.
        this.outcome.withheldBy = 'no_instance'
      } else {
        this.outcome.withheldBy = this.retrievalInsufficient
          ? 'retrieval_insufficient'
          : this.hydrationRejected
            ? 'hydration_rejected'
            : 'no_citation'
        // The template keys on the bin as well as retrieval: a question anchored on a repository
        // name, or an anchored-only one, was decided in scope upstream, so telling the user it is
        // out of scope would be a false refusal (BL-08; UAT 2026-09-15, a suggested question).
        yield this.retrievalInsufficient || this.bin === 'anchored_only' || this.anchored
          ? this.notice('absence', this.ctx.templates.absence)
          : this.notice(
              'out_of_scope',
              this.ctx.templates.outOfScope
                .replace('{repository}', this.ctx.repository)
                .replace('{commit}', this.ctx.commitSha.slice(0, 7))
            )
      }
    }
    yield terminal
  }

  /** At least one held sentence is a confirmed absence, and no held sentence claims anything else. */
  private onlyConfirmedAbsences(held: Array<{ text: string }>): boolean {
    if (!this.ctx.verifier) return false
    const outcomes = held.flatMap((h) =>
      this.ctx.verifier!.verify('held', h.text, false).filter((e) => e.type === 'verification')
    ) as Array<Extract<AnswerEvent, { type: 'verification' }>>
    return (
      outcomes.length > 0 &&
      outcomes.every((v) => v.status === 'verified' && v.detail.startsWith('confirmed absent:'))
    )
  }

  private notice(kind: ScopeNotice['kind'], text: string): AnswerEvent {
    return {
      type: 'view',
      component: 'scope_notice',
      data: {
        component: 'scope_notice',
        kind,
        text,
        suggestedQuestions: this.ctx.suggestedQuestions,
      },
    }
  }
}

/** A fenced code block is one unit: no sentence boundary is taken inside it. */
function insideFence(text: string, at: number): boolean {
  return (text.slice(0, at).match(/```/g)?.length ?? 0) % 2 === 1
}

function isNotice(event: Extract<AnswerEvent, { type: 'view' }>): boolean {
  return event.component === 'scope_notice'
}
