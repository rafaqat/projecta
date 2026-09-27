import type { GatewayDecisions } from '#guards/index'
import { randomUUID } from 'node:crypto'
import { trace } from '@opentelemetry/api'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import env from '#start/env'
import type { GateOutcome } from '#app/assistant/evidence_gate'
import type { AnswerEvent } from '#app/assistant/protocol'
import { configHash, validatedRunFor } from '#app/audit/config_hash'
import { commit } from '#app/security/commitment'

/**
 * The decision record (design §9): one per turn, written through
 * audit_outbox in the transaction that completes the turn. It holds
 * references and hashes, never text: question, answer and withheld text
 * stay in the thread as erasable content and the record keeps only their
 * keyed commitments.
 */
export interface TurnTrace {
  runId?: string
  scope?: { label: string; stage: string; ruleId: string }
  /** The question scored by the injection detector; undefined when the detector was unavailable. */
  questionSuspected?: boolean
  /** Evidence items the answer was built from that ingest flagged, including tool-added ones. */
  flaggedEvidence?: number
  /** The evidence pack this turn was built on; absent on the routed path. */
  pack?: { seedSource: string; seeds: string[]; items: number }
  /**
   * What the gateway reported it checked. Absent when no gateway was in the path, which
   * is a different fact from "nothing fired" and is shown as such.
   */
  gateway?: GatewayDecisions
  /**
   * This turn carried a compliance canary. Recorded per turn rather than folded into
   * `configHash`: the rate is a property of the deployment, but whether this answer was produced
   * with the extra block present is a property of this answer, and that is what an audit needs.
   */
  canary?: boolean
  retrieval?: {
    status: string
    shown: number
    total: number
    truncated: boolean
    queriesRun: string[]
    excludedPaths: string[]
    candidates: Array<{
      chunkId: string
      path: string
      span: { start: number; end: number }
      rank: number
      /** Flagged at ingest as instruction-shaped (T-07). */
      injectionSuspected?: boolean
    }>
  }
  tools: Array<{ name: string; argDigest: string; status: string }>
  /** Structured views shown, and who chose each: a router pre-run (index) or the model's tool call
   *  (model). Measures whether the prompt's view guidance is being used (B1). */
  views?: Array<{ component: string; source: 'index' | 'model' }>
  modelCalls: number
}

export const emptyTrace = (): TurnTrace => ({ tools: [], modelCalls: 0 })

export type Citation = Extract<AnswerEvent, { type: 'citation' }>

export interface DecisionEnvelope {
  occurredAt: string
  actor: { userId: string; kind: 'user' | 'service' }
  system: {
    appVersion: string
    imageDigest: string
    configHash: string
    validatedByRun: string | null
  }
  input: {
    questionCommitment: string
    inputLength: number
    scope: TurnTrace['scope'] | null
    /** The question was scored as an injection; annotation only. */
    injectionSuspected: boolean
    /** The evidence carried a compliance canary. */
    canary: boolean
  }
  /** What the gateway said it did; null when none was in the path. */
  gateway: GatewayDecisions | null
  evidence: {
    commitSha: string
    retrieval: TurnTrace['retrieval'] | null
    citations: Array<{
      handle: string
      blobSha: string
      spanSha256: string
      path: string
      span: { start: number; end: number }
    }>
    dropped: string[]
    tools: TurnTrace['tools']
    gate: {
      evidence: boolean
      declined: boolean
      demand: GateOutcome['demand']
      withheldChars: number
      /** What removed the last piece of evidence when text was withheld; null when nothing was (BL-00). */
      withheldBy: GateOutcome['withheldBy']
    }
    verification: {
      verified: number
      dependency: number
      unverified: number
      /** absent from records written before it. */
      not_checkable?: number
    }
    /** Retrieved candidates flagged at ingest as instruction-shaped (T-07). */
    injectionSuspected: number
    modelCalls: number
    model: string
  }
  outcome: {
    runState: string
    answerCommitment: string
    withheldCommitment: string | null
    noticeKind: string | null
  }
  traceId: string
}

export interface TurnCompletion {
  turnId: string
  threadId: string
  scope: { userId: number; workspaceId: string }
  commitId: string
  commitSha: string
  runHandle: string
  runState: string
  question: string
  gate: GateOutcome
  citations: Citation[]
  verification: {
    verified: number
    dependency: number
    unverified: number
    /** absent from records written before it. */
    not_checkable?: number
  }
  noticeKind: string | null
  declined: boolean
  trace: TurnTrace
  model: string
  /** The released event stream, for history to render as it streamed; never the withheld text. */
  events?: unknown[]
}

/** Writes the turn, its citations and the decision.recorded outbox row in one transaction. */
export async function recordTurn(
  trx: TransactionClientContract,
  c: TurnCompletion
): Promise<DecisionEnvelope> {
  const question = commit(c.question)
  const answer = commit(c.gate.released)
  const withheld = c.gate.withheld ? commit(c.gate.withheld) : null
  const { hash } = configHash()
  const record: DecisionEnvelope = {
    occurredAt: new Date().toISOString(),
    actor: { userId: String(c.scope.userId), kind: 'user' },
    system: {
      appVersion: env.get('APP_VERSION'),
      imageDigest: process.env.IMAGE_DIGEST ?? 'local',
      configHash: hash,
      validatedByRun: validatedRunFor(hash),
    },
    input: {
      questionCommitment: question.commitment,
      inputLength: c.question.length,
      scope: c.trace.scope ?? null,
      injectionSuspected: c.trace.questionSuspected === true,
      canary: c.trace.canary === true,
    },
    gateway: c.trace.gateway ?? null,
    evidence: {
      commitSha: c.commitSha,
      retrieval: c.trace.retrieval ?? null,
      citations: c.citations.map((x) => ({
        handle: x.handle,
        blobSha: x.blobSha,
        spanSha256: x.spanSha256,
        path: x.symbol.path,
        span: x.span,
      })),
      dropped: c.trace.retrieval?.excludedPaths ?? [],
      tools: c.trace.tools,
      gate: {
        evidence: c.gate.evidence,
        declined: c.declined,
        demand: c.gate.demand,
        withheldChars: c.gate.withheld.length,
        withheldBy: c.gate.withheldBy,
      },
      verification: c.verification,
      injectionSuspected:
        c.trace.flaggedEvidence ??
        c.trace.retrieval?.candidates.filter((x) => x.injectionSuspected).length ??
        0,
      modelCalls: c.trace.modelCalls,
      model: c.model,
    },
    outcome: {
      runState: c.runState,
      answerCommitment: answer.commitment,
      withheldCommitment: withheld?.commitment ?? null,
      noticeKind: c.noticeKind,
    },
    traceId: trace.getActiveSpan()?.spanContext().traceId ?? '',
  }
  await trx.table('turns').insert({
    id: c.turnId,
    thread_id: c.threadId,
    workspace_id: c.scope.workspaceId,
    run_handle: c.runHandle,
    commit_id: c.commitId,
    question: c.question,
    question_salt: question.salt,
    answer_text: c.gate.released,
    answer_salt: answer.salt,
    withheld_text: c.gate.withheld,
    withheld_salt: withheld?.salt ?? null,
    released: c.gate.withheld.length === 0,
    citation_handles: JSON.stringify(c.citations.map((x) => x.handle)),
    events: c.events ? JSON.stringify(c.events) : null,
    run_state: c.runState,
    scope_label: c.noticeKind ?? c.trace.scope?.label ?? null,
    config_hash: hash,
    trace_id: trace.getActiveSpan()?.spanContext().traceId ?? null,
    created_at: new Date(),
  })
  for (const x of c.citations) {
    await trx.table('turn_citations').insert({
      id: randomUUID(),
      workspace_id: c.scope.workspaceId,
      turn_id: c.turnId,
      handle: x.handle,
      commit_sha: x.commitSha,
      blob_sha: x.blobSha,
      path: x.symbol.path,
      start_line: x.span.start,
      end_line: x.span.end,
      span_sha256: x.spanSha256,
    })
  }
  await trx.table('audit_outbox').insert({
    workspace_id: c.scope.workspaceId,
    event: 'decision.recorded',
    payload: JSON.stringify({ turnId: c.turnId, runHandle: c.runHandle, record }),
  })
  return record
}

/** Erasure: content and salts go together; the record's commitments become unverifiable. */
export async function eraseTurn(trx: TransactionClientContract, turnId: string): Promise<void> {
  await trx.from('turns').where('id', turnId).update({
    question: '',
    question_salt: null,
    answer_text: '',
    answer_salt: null,
    withheld_text: '',
    withheld_salt: null,
    events: null,
    erased_at: new Date(),
  })
}
