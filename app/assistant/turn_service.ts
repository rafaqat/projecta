import { randomUUID } from 'node:crypto'
import { EvidenceGate } from '#app/assistant/evidence_gate'
import { canaryRate } from '#app/assistant/compliance_canary'
import env from '#start/env'
import { echoesComment } from '#app/assistant/quoted_comment'
import { emptyTrace, recordTurn, type Citation, type TurnTrace } from '#app/audit/decision_record'
import { InProcessOrchestrator } from '#app/assistant/in_process'
import type { ContinuationPayload, Orchestrator, TurnInput } from '#app/assistant/orchestrator'
import type { AnswerEvent } from '#app/assistant/protocol'
import { EntityVerifier } from '#app/assistant/verification'
import { createModelClient, MODELS } from '#app/llm/client'
import { defaultThrottle } from '#app/retrieval/answer_route'
import { scopePolicy } from '#app/retrieval/router'
import { AnthropicScopeClassifier } from '#app/retrieval/scope_classifier'
import { loadVocabulary, suggestedQuestions, textIdentifiers } from '#app/retrieval/vocabulary'
import { isAblated, testSeam } from '#app/security/ablation_switch'
import { inScope, type Scope } from '#app/security/scope'
import { newHandle } from '#app/security/handles'

/**
 * One turn end to end (design §6): thread lookup, continuation payload,
 * Orchestrator.run, the EvidenceGate, and persistence of what was released
 * and what was withheld. The route encodes the resulting events; nothing
 * here writes to the response.
 */
export interface TurnRequest {
  scope: Scope
  repository: { id: string; name: string; activeCommitId: string }
  question: string
  threadHandle?: string
  regenerate?: { turnHandle: string; invalidEntities: string[] }
  requestId?: string
}

export interface TurnDeps {
  orchestrator?: Orchestrator
  gateFault?: () => void
  /** Observes the gate for measurement (smoke run, calibration). */
  onGate?: (gate: EvidenceGate) => void
  /** The turn's trace once the run is over, for measurement (view-selection eval). */
  onTrace?: (trace: TurnTrace) => void
}

const singleton: { orchestrator?: Orchestrator; throttle?: ReturnType<typeof defaultThrottle> } = {}

export function defaultOrchestrator(): Orchestrator {
  singleton.throttle ??= defaultThrottle()
  singleton.orchestrator ??= new InProcessOrchestrator({
    model: createModelClient(),
    classifier: new AnthropicScopeClassifier(MODELS.scopeClassifier),
    throttle: singleton.throttle,
    // The compliance canary, off until a deployment sets a rate.
    canarySampling: { rate: canaryRate(env.get('CANARY_SAMPLE_RATE')) },
  })
  return singleton.orchestrator
}

export class InputRejectedError extends Error {
  readonly code = 'E_INPUT_REJECTED'
  constructor(readonly reason: 'too_long' | 'attachment' | 'empty' | 'regenerated') {
    super(reason)
  }
}

/** Layer 1: the input cap applies before routing, and attachments are refused. */
export function checkInput(question: string, hasAttachment: boolean): void {
  const policy = scopePolicy()
  if (hasAttachment) throw new InputRejectedError('attachment')
  if (question.trim().length === 0) throw new InputRejectedError('empty')
  if (question.length > policy.inputCapCharacters) throw new InputRejectedError('too_long')
}

export async function* answerTurn(
  req: TurnRequest,
  signal: AbortSignal,
  deps: TurnDeps = {}
): AsyncIterable<AnswerEvent> {
  const policy = scopePolicy()
  const { scope, repository } = req
  const commit = await inScope(scope, (trx) =>
    trx.from('commits').where('id', repository.activeCommitId).first()
  )
  // A regeneration belongs to the thread of the turn it regenerates: the page knows the
  // turn's handle, and the thread is found from it, never created.
  const thread = req.regenerate
    ? await claimRegeneration(scope, req.repository.id, req.regenerate.turnHandle)
    : await findOrCreateThread(req)
  const continuation = await buildContinuation(scope, thread.id)
  const vocabulary = await loadVocabulary(scope, repository.activeCommitId)

  const turnId = randomUUID()
  const trace = emptyTrace()
  const input: TurnInput = {
    scope,
    repositoryId: repository.id,
    commitId: repository.activeCommitId,
    commitSha: commit.sha,
    repositoryName: repository.name,
    question: req.question,
    continuation,
    strict: req.regenerate ? { invalidEntities: req.regenerate.invalidEntities } : undefined,
    call: {
      userId: scope.userId,
      workspaceId: scope.workspaceId!,
      requestId: req.requestId ?? randomUUID(),
      purpose: 'answer',
      signer: 'web',
      // Recorded, never branched on: the gateway enforces, the app keeps what it said.
      onGatewayDecisions: (decisions) => (trace.gateway = decisions),
    },
    trace,
    onEvidence: (e) => {
      evidence = e
      // The outlines the turn shows are the verifier's to check uncited names against.
      e.onOutline((path, declarations) => verifier.addOutline(path, declarations))
    },
  }
  // The quoted-comment rule asks the turn's evidence, which the orchestrator mints later
  // (TurnInput.onEvidence); an uncited echo of a comment is withheld (live baseline 2026-09-18).
  let evidence: { comments(): string[] } | null = null
  const verifier = new EntityVerifier({
    ...vocabulary,
    textIdentifiers: await textIdentifiers(scope, repository.activeCommitId),
  })
  const quotedComment = (await isAblated('no_quoted_comment_rule'))
    ? undefined
    : (sentence: string) => (evidence ? echoesComment(sentence, evidence.comments()) : false)
  const gate = new EvidenceGate({
    quotedComment,
    budgets: policy.gate,
    anchoredOnlyBudgets: policy.gate.anchoredOnly,
    templates: policy.templates,
    repository: repository.name,
    commitSha: commit.sha,
    suggestedQuestions: suggestedQuestions(vocabulary),
    verifier,
    fault: deps.gateFault,
  })
  deps.onGate?.(gate)
  const orchestrator =
    deps.orchestrator ?? (await testSeam<Orchestrator>('orchestrator')) ?? defaultOrchestrator()
  // Ablation `no_output_gate` (enforcement) shows what the gate contributes; test targets only.
  const stream = (await isAblated('no_output_gate'))
    ? orchestrator.run(input, signal)
    : gate.apply(orchestrator.run(input, signal))
  let runId = ''
  let runState = 'failed'
  let noticeKind: string | null = null
  let declined = false
  const citations: Citation[] = []
  const released: AnswerEvent[] = []
  const verification = { verified: 0, dependency: 0, unverified: 0, not_checkable: 0 }
  try {
    for await (const event of stream) {
      released.push(event)
      if (event.type === 'status') {
        runId = event.runId
        runState = event.runState
        input.call!.turnHandle = runId
      } else if (event.type === 'citation') {
        citations.push(event)
      } else if (event.type === 'verification') {
        verification[event.status]++
      } else if (event.type === 'view' && event.component === 'scope_notice') {
        const kind = (event.data as { kind: string }).kind
        if (kind === 'decline') declined = true
        else noticeKind = kind
      }
      yield event
    }
  } finally {
    deps.onTrace?.(trace)
    // The turn, its citations and the decision record land in one transaction (design §9).
    await inScope(scope, (trx) =>
      recordTurn(trx, {
        turnId,
        threadId: thread.id,
        scope: { userId: scope.userId, workspaceId: scope.workspaceId! },
        commitId: repository.activeCommitId,
        commitSha: commit.sha,
        runHandle: runId || newHandle(),
        runState,
        question: req.question,
        gate: gate.outcome,
        citations,
        verification,
        noticeKind,
        declined,
        trace,
        model: orchestrator.modelId ?? 'scripted',
        events: released,
      })
    )
  }
}

export async function findOrCreateThread(
  req: TurnRequest
): Promise<{ id: string; handle: string }> {
  return inScope(req.scope, async (trx) => {
    if (req.threadHandle) {
      const existing = await trx
        .from('threads')
        .where({
          handle: req.threadHandle,
          repository_id: req.repository.id,
          user_id: req.scope.userId,
        })
        .first()
      if (existing) return { id: existing.id, handle: existing.handle }
    }
    const thread = { id: randomUUID(), handle: newHandle() }
    await trx.table('threads').insert({
      ...thread,
      workspace_id: req.scope.workspaceId,
      repository_id: req.repository.id,
      user_id: req.scope.userId,
      created_at: new Date(),
    })
    return thread
  })
}

/** Prior answer text and citation handles only: never tool results (INV-15). */
export async function buildContinuation(
  scope: Scope,
  threadId: string
): Promise<ContinuationPayload> {
  const rows = await inScope(scope, (trx) =>
    trx
      .from('turns')
      .where('thread_id', threadId)
      .orderBy('created_at')
      .select('answer_text', 'citation_handles')
  )
  return {
    answers: rows
      .filter((r) => r.answer_text)
      .map((r) => ({
        text: r.answer_text as string,
        citationHandles: r.citation_handles as string[],
      })),
  }
}

/**
 * One strict regeneration per turn: claims the turn by its handle within the
 * repository (row-level security keeps it to the workspace) and returns its
 * thread. An unknown or already regenerated turn is an input rejection.
 */
async function claimRegeneration(
  scope: Scope,
  repositoryId: string,
  turnHandle: string
): Promise<{ id: string; handle: string }> {
  return inScope(scope, async (trx) => {
    const turn = await trx
      .from('turns')
      .join('threads', 'threads.id', 'turns.thread_id')
      .where({ 'turns.run_handle': turnHandle, 'threads.repository_id': repositoryId })
      .select('turns.id', 'turns.strict_regenerated', 'threads.id as thread_id', 'threads.handle')
      .first()
    if (!turn || turn.strict_regenerated) throw new InputRejectedError('regenerated')
    await trx.from('turns').where('id', turn.id).update({ strict_regenerated: true })
    return { id: String(turn.thread_id), handle: String(turn.handle) }
  })
}
