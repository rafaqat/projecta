import type { OutlinedDeclaration } from '#app/assistant/verification'
import type { AnswerEvent } from '#app/assistant/protocol'
import type { Scope } from '#app/security/scope'
import type { CallContext } from '#app/audit/ledger'
import type { TurnTrace } from '#app/audit/decision_record'

/**
 * The only way the answer route and the eval API reach the agent loop
 *. `run` yields the closed AnswerEvent union; every stream starts
 * with a `status` event whose runId is an opaque handle assigned before
 * retrieval. `resume` exists for a future durable implementation.
 */
export interface TurnInput {
  scope: Scope
  repositoryId: string
  commitId: string
  commitSha: string
  repositoryName: string
  question: string
  /** Prior answer text and citation handles only. */
  continuation?: ContinuationPayload
  strict?: { invalidEntities: string[] }
  /** Ledger and attribution context for provider calls made in this turn (design §8). */
  call?: CallContext
  /** Filled by the implementation for the decision record (design §9); not an event. */
  trace?: TurnTrace
  /**
   * The turn's evidence once minted, for the gate's quoted-comment rule (it is built before the
   * orchestrator runs and asks the evidence lazily); not an event.
   */
  onEvidence?: (evidence: {
    comments(): string[]
    /** Outlines added to the evidence, now and later. */
    onOutline(listen: (path: string, declarations: OutlinedDeclaration[]) => void): void
  }) => void
}

export interface ContinuationPayload {
  answers: Array<{ text: string; citationHandles: string[] }>
}

export type HumanDecision = { outcome: 'approve' | 'reject'; reason: string }

export interface Orchestrator {
  /** The answer model behind this implementation, for the decision record. */
  readonly modelId?: string
  run(input: TurnInput, signal: AbortSignal): AsyncIterable<AnswerEvent>
  resume(runId: string, decision: HumanDecision, signal: AbortSignal): AsyncIterable<AnswerEvent>
}

export class ResumeUnsupportedError extends Error {
  readonly code = 'E_RESUME_UNSUPPORTED'
  constructor(runId: string) {
    super(`run ${runId} cannot be resumed: the in-process orchestrator keeps no run state`)
  }
}
