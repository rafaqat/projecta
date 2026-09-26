import type { TurnEvidence } from '#app/assistant/evidence'
import type {
  ContentBlock,
  ModelClient,
  ModelMessage,
  NativeCitation,
  SearchResultBlock,
} from '#app/assistant/model'
import type { ContinuationPayload } from '#app/assistant/orchestrator'
import type { Tool, ToolResultContent } from '#app/assistant/tools'
import type { CallContext } from '#app/audit/ledger'
import { createHash } from 'node:crypto'
import logger from '@adonisjs/core/services/logger'
import { securityEvents } from '#app/security/events/index'

/**
 * The explicit agent loop. Retrieval has already happened when
 * this runs: the first user message carries the search-result blocks. The
 * loop enforces the iteration cap, per-tool timeouts and the turn deadline,
 * and aborts the upstream request when the caller's signal fires. It never
 * replays a partially streamed answer. Only the in-process orchestrator may
 * import this module (AC-WP06-20).
 */
export interface AgentLimits {
  maxToolIterations: number
  toolTimeoutMs: number
  turnDeadlineMs: number
}

export const DEFAULT_LIMITS: AgentLimits = {
  maxToolIterations: 5,
  // A retrieval on a real repository through the model server can take longer than 5 s
  // (UAT 2026-09-16: search_code timed out twice on Sejima); the turn deadline still bounds it.
  toolTimeoutMs: 15_000,
  turnDeadlineMs: 60_000,
}

export type AgentEvent =
  | { type: 'text'; delta: string; block?: number }
  | { type: 'citation'; native: NativeCitation; block?: number }
  | {
      type: 'tool'
      name: string
      input: unknown
      /** `index`: run by the system before the model's first turn (the index answers first). */
      status: 'ok' | 'timeout' | 'error' | 'refused' | 'unknown' | 'index'
    }
  | { type: 'model_call' }
  | {
      type: 'done'
      reason: 'end_turn' | 'iterations' | 'deadline' | 'aborted' | 'model_error' | 'output_blocked'
      /** Present for model_error: the error's code, never its message. */
      errorCode?: string
      /** Present for output_blocked: the gateway rule that ended the answer. */
      rule?: string
    }

export interface AgentInput {
  model: ModelClient
  system: string
  question: string
  evidenceBlocks: SearchResultBlock[]
  /**
   * Tools the system ran before the model's first turn (the index answers first:
   * usages dependencies, the file outline). Each becomes an assistant tool_use and
   * its tool_result after the question, so the model reads a result — never a table pasted
   * beside the question (UAT 2026-09-16: "you haven't asked a question yet").
   */
  preRuns?: PreRun[]
  tools: Tool[]
  evidence: TurnEvidence
  continuation?: ContinuationPayload
  strict?: { invalidEntities: string[] }
  limits?: Partial<AgentLimits>
  call?: CallContext
}

export interface PreRun {
  name: string
  input: unknown
  content: ToolResultContent
}

export async function* runAgent(input: AgentInput, signal: AbortSignal): AsyncIterable<AgentEvent> {
  const limits = { ...DEFAULT_LIMITS, ...input.limits }
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort('deadline'), limits.turnDeadlineMs)
  const upstream = AbortSignal.any([signal, deadline.signal])
  const messages = initialMessages(input)
  const tools = new Map(input.tools.map((t) => [t.spec.name, t]))
  let iterations = 0
  let toolsAllowed = true
  try {
    for (const run of input.preRuns ?? [])
      yield { type: 'tool', name: run.name, input: run.input, status: 'index' }
    for (;;) {
      const assistant: ContentBlock[] = []
      const toolUses: Array<{ id: string; name: string; input: unknown }> = []
      let textSoFar = ''
      let stop: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn'
      yield { type: 'model_call' }
      try {
        for await (const event of input.model.stream(
          {
            system: input.system,
            messages,
            tools: input.tools.map((t) => t.spec),
            toolChoice: toolsAllowed ? 'auto' : 'none',
          },
          upstream,
          input.call
        )) {
          if (event.type === 'text') {
            textSoFar += event.delta
            yield { type: 'text', delta: event.delta, block: event.block }
            for (const native of event.citations ?? [])
              yield { type: 'citation', native, block: event.block }
          } else if (event.type === 'tool_use') {
            toolUses.push(event)
          } else {
            stop = event.stopReason
          }
        }
      } catch (error) {
        if (upstream.aborted) {
          yield { type: 'done', reason: signal.aborted ? 'aborted' : 'deadline' }
        } else if ((error as { code?: string }).code === 'E_OUTPUT_BLOCKED') {
          // The gateway ended the answer on an output rule: a decision, not a failure.
          yield {
            type: 'done',
            reason: 'output_blocked',
            rule: (error as { rule?: string }).rule ?? 'output',
          }
        } else {
          // Never swallowed: the failure is reported with a code and a message hash.
          yield {
            type: 'done',
            reason: 'model_error',
            errorCode: reportModelError(error, input.call),
          }
        }
        return
      }
      if (upstream.aborted) {
        yield { type: 'done', reason: signal.aborted ? 'aborted' : 'deadline' }
        return
      }
      if (stop !== 'tool_use' || toolUses.length === 0 || !toolsAllowed) {
        yield { type: 'done', reason: toolsAllowed ? 'end_turn' : 'iterations' }
        return
      }
      if (iterations >= limits.maxToolIterations) {
        // The sixth round is refused; the model then answers from the evidence it already has.
        for (const use of toolUses)
          yield { type: 'tool', name: use.name, input: use.input, status: 'refused' }
        if (textSoFar) assistant.push({ type: 'text', text: textSoFar })
        for (const use of toolUses) assistant.push({ type: 'tool_use', ...use })
        messages.push(
          { role: 'assistant', content: assistant },
          {
            role: 'user',
            content: toolUses.map((use) => ({
              type: 'tool_result' as const,
              toolUseId: use.id,
              content: [
                {
                  type: 'text' as const,
                  text: 'tool budget exhausted: answer with the evidence already provided',
                },
              ],
            })),
          }
        )
        toolsAllowed = false
        continue
      }
      iterations++
      if (textSoFar) assistant.push({ type: 'text', text: textSoFar })
      for (const use of toolUses) assistant.push({ type: 'tool_use', ...use })
      const results: ContentBlock[] = []
      for (const use of toolUses) {
        const tool = tools.get(use.name)
        if (!tool) {
          yield { type: 'tool', name: use.name, input: use.input, status: 'unknown' }
          results.push({
            type: 'tool_result',
            toolUseId: use.id,
            content: [{ type: 'text', text: 'unknown tool' }],
          })
          continue
        }
        const outcome = await withTimeout(tool.run(use.input), limits.toolTimeoutMs, upstream)
        yield {
          type: 'tool',
          name: use.name,
          input: use.input,
          status: outcome.status,
        }
        results.push(
          ...toolResultBlocks(
            use.id,
            outcome.status === 'ok'
              ? outcome.content
              : [{ type: 'text', text: `tool ${outcome.status}` }]
          )
        )
      }
      // Every tool_result first, then the search results they refer to.
      const ordered = [
        ...results.filter((b) => b.type === 'tool_result'),
        ...results.filter((b) => b.type !== 'tool_result'),
      ]
      messages.push({ role: 'assistant', content: assistant }, { role: 'user', content: ordered })
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A tool's content as the provider accepts it: the tool_result holds text only, and any
 * citable results follow it in the same user message as search_result blocks. The provider
 * refuses a tool_result mixing text and search_result blocks, and refuses search_result
 * blocks with citations disabled beside ones with citations enabled (2026-09-16).
 */
function toolResultBlocks(toolUseId: string, content: ToolResultContent): ContentBlock[] {
  const texts = content.filter((c) => c.type === 'text') as Array<{ type: 'text'; text: string }>
  const results = content.filter((c) => c.type === 'search_result')
  const summary =
    texts.length > 0
      ? texts
      : [{ type: 'text' as const, text: `${results.length} result(s) follow` }]
  return [{ type: 'tool_result', toolUseId, content: summary }, ...results]
}

function initialMessages(input: AgentInput): ModelMessage[] {
  const messages: ModelMessage[] = []
  // Continuations carry prior answer text and citation handles only (INV-15).
  for (const prior of input.continuation?.answers ?? []) {
    messages.push({ role: 'assistant', content: [{ type: 'text', text: prior.text }] })
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: `(cited: ${prior.citationHandles.join(', ') || 'none'})` }],
    })
  }
  const strict = input.strict?.invalidEntities.length
    ? `\nThese names were not found in the repository and must not be asserted: ${input.strict.invalidEntities.join(', ')}.`
    : ''
  messages.push({
    role: 'user',
    content: [...input.evidenceBlocks, { type: 'text', text: input.question + strict }],
  })
  ;(input.preRuns ?? []).forEach((run, i) => {
    const id = `pre_${i + 1}_${run.name}`
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: run.name, input: run.input }],
    })
    messages.push({ role: 'user', content: toolResultBlocks(id, run.content) })
  })
  return messages
}

async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  signal: AbortSignal
): Promise<{ status: 'ok'; content: T } | { status: 'timeout' | 'error' }> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<{ status: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timeout' }), ms)
    signal.addEventListener('abort', () => resolve({ status: 'timeout' }), { once: true })
  })
  try {
    return await Promise.race([
      work.then((content) => ({ status: 'ok' as const, content })),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Emits error.unhandled for a failed model call and returns the code it carried. */
function reportModelError(error: unknown, call: CallContext | undefined): string {
  const errorCode = (error as { code?: unknown }).code
  const code =
    typeof errorCode === 'string'
      ? errorCode
      : `E_MODEL_${(error as { name?: string }).name ?? 'ERROR'}`
  const message = error instanceof Error ? error.message : String(error)
  const status = (error as { status?: unknown }).status
  const hash = createHash('sha256').update(message).digest('hex').slice(0, 16)
  securityEvents.emit('error.unhandled', {
    errorCode: code,
    errorHash: hash,
    status: typeof status === 'number' ? status : 502,
    requestId: call?.requestId ?? '',
  })
  // The hash alone cannot be read back (UAT 2026-09-16: three E_MODEL_Error with nothing to
  // open); the class, the provider's status and the head of the message go to the application
  // log, which the collector redacts. Never the request or the answer.
  logger.warn(
    {
      errorCode: code,
      errorHash: hash,
      errorName: (error as { name?: string }).name ?? 'Error',
      status: typeof status === 'number' ? status : null,
      message: message.slice(0, 240),
      requestId: call?.requestId ?? '',
    },
    'model call failed'
  )
  return code
}
