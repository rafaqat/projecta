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
import { classifyModelError } from '#app/assistant/model_error'
import { startSpan } from '#app/security/telemetry/spans'
import { logTurnContent } from '#app/security/telemetry/content_log'
import type { Span } from '@opentelemetry/api'
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
      /** Present for model_error when a transport failure wrapped an errno (`EAI_AGAIN`, ...). */
      errorCause?: string
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
  /**
   * The turn's span, so each round nests under it. Passed rather than taken from the ambient
   * context: this is a generator, and the context does not survive a yield (spans.ts).
   */
  parentSpan?: Span
  /** The turn's run handle, so its content records are findable by the identifier a reader has. */
  runHandle?: string
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
  // Passes through the loop, which is what a round span represents. Not the same as `iterations`,
  // which counts only the rounds that executed tools and is what the cap is measured against: the
  // round that refuses a sixth tool call and the round that then answers both leave `iterations` at
  // five, so numbering spans by it gave two spans the same round.
  let pass = 0
  let toolsAllowed = true
  // The loop's spans (ADR-023). One per round, closed on every exit path including a throw, so a
  // turn that ends mid-round leaves a span saying which round and why rather than nothing.
  let round: Span | undefined
  const endRound = (attributes: Record<string, string | number | boolean> = {}) => {
    round?.setAttributes(attributes)
    round?.end()
    round = undefined
  }
  try {
    for (const run of input.preRuns ?? []) {
      // The index answered before the model's first turn. It is a tool call in the transcript, so
      // it is one in the trace too: without a span the dashboard shows a turn with 46 citations and
      // no tool call, which reads as retrieval having found them.
      const preSpan = startSpan(
        'agent.tool',
        {
          'app.tool.name': run.name,
          'app.tool.status': 'index',
          'app.agent.round': 0,
        },
        input.parentSpan
      )
      preSpan.end()
      yield { type: 'tool', name: run.name, input: run.input, status: 'index' }
    }
    for (;;) {
      pass += 1
      round = startSpan(
        'agent.round',
        {
          'app.agent.round': pass,
          'app.agent.iterations': iterations,
          // The question is on the turn span, which is this span's parent. Repeating it per round
          // carried it seven times through a six-round turn for nothing a nested trace does not
          // already show.
        },
        input.parentSpan
      )
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
          const reason = signal.aborted ? 'aborted' : 'deadline'
          endRound({ 'app.agent.stop_reason': reason })
          yield { type: 'done', reason }
        } else if ((error as { code?: string }).code === 'E_OUTPUT_BLOCKED') {
          // The gateway ended the answer on an output rule: a decision, not a failure.
          const rule = (error as { rule?: string }).rule ?? 'output'
          endRound({ 'app.agent.stop_reason': 'output_blocked', 'app.policy.rule': rule })
          yield { type: 'done', reason: 'output_blocked', rule }
        } else {
          // Never swallowed: the failure is reported with a code and a message hash.
          const facts = reportModelError(error, input.call)
          endRound({ 'app.agent.stop_reason': 'model_error', 'app.error.code': facts.errorCode })
          yield { type: 'done', reason: 'model_error', ...facts }
        }
        return
      }
      if (upstream.aborted) {
        const reason = signal.aborted ? 'aborted' : 'deadline'
        endRound({ 'app.agent.stop_reason': reason })
        yield { type: 'done', reason }
        return
      }
      if (stop !== 'tool_use' || toolUses.length === 0 || !toolsAllowed) {
        const reason = toolsAllowed ? 'end_turn' : 'iterations'
        endRound({ 'app.agent.stop_reason': reason, 'app.agent.tools_requested': toolUses.length })
        yield { type: 'done', reason }
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
        endRound({
          'app.agent.stop_reason': 'tool_budget_exhausted',
          'app.agent.tools_requested': toolUses.length,
        })
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
        const toolSpan = startSpan(
          'agent.tool',
          {
            'app.tool.name': use.name,
            'app.agent.round': pass,
          },
          round
        )
        const outcome = await withTimeout(tool.run(use.input), limits.toolTimeoutMs, upstream)
        toolSpan.setAttributes({
          'app.tool.status': outcome.status,
          // What the model was handed back, beside what it asked for. Without this a trace shows
          // the request and the verdict and leaves the answer's input to inference.
        })
        toolSpan.end()
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
      endRound({
        'app.agent.stop_reason': 'tool_use',
        'app.agent.tools_requested': toolUses.length,
      })
    }
  } finally {
    // A throw between rounds, or a consumer abandoning the generator, must not leak an open span.
    endRound({ 'app.agent.stop_reason': 'incomplete' })
    // The literal array the model was last sent. `messages` is append-only within a turn, so the
    // final state contains every earlier one and capturing it here costs one copy rather than one
    // per round. It overlaps the evidence text and the tool outputs on their own spans by design:
    // those answer "what was retrieved" and "what did this tool return", this answers "what was in
    // the request", and a reader chasing a model's behaviour wants the request as it was sent.
    const request = JSON.stringify(messages)
    // The span carries what fits (Tempo cuts at 2 KB and says nothing, so the cap is ours and
    // marked); the log record carries the whole of it, joined to this trace by trace id.
    logTurnContent('messages', request, input.call?.requestId, input.runHandle)
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

/**
 * Emits error.unhandled for a failed model call and returns what the turn reports.
 *
 * The code and the errno are the whole of what survives export (SEC-14), so they are what the run
 * status carries too: a reader of the console and a reader of the dashboard name the same failure.
 */
function reportModelError(
  error: unknown,
  call: CallContext | undefined
): { errorCode: string; errorCause?: string } {
  const facts = classifyModelError(error)
  const message = error instanceof Error ? error.message : String(error)
  const hash = createHash('sha256').update(message).digest('hex').slice(0, 16)
  securityEvents.emit('error.unhandled', {
    errorCode: facts.code,
    errorCause: facts.cause ?? '',
    errorHash: hash,
    status: facts.status ?? 502,
    requestId: call?.requestId ?? '',
  })
  // The hash alone cannot be read back (UAT 2026-09-16: three E_MODEL_Error with nothing to
  // open); the class, the provider's status and the head of the message go to the application
  // log, which the collector redacts. Never the request or the answer.
  logger.warn(
    {
      errorCode: facts.code,
      errorCause: facts.cause ?? null,
      errorHash: hash,
      errorName: (error as { name?: string }).name ?? 'Error',
      status: facts.status ?? null,
      message: message.slice(0, 240),
      requestId: call?.requestId ?? '',
    },
    'model call failed'
  )
  return { errorCode: facts.code, ...(facts.cause ? { errorCause: facts.cause } : {}) }
}
