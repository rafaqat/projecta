import logger from '@adonisjs/core/services/logger'
import { createHash } from 'node:crypto'
import { securityEvents } from '#app/security/events/index'
import type { CallContext } from '#app/audit/ledger'
import { ROUTE_LABELS, type RouteLabel } from '#app/retrieval/router'

/**
 * Stage 2: one cheap classification with output restricted to the
 * closed label set. Anything malformed, off-enum, or late maps to
 * `ambiguous`, which proceeds to retrieval and lets the evidence gate decide.
 */
export interface ScopeClassifier {
  id: string
  classify(question: string, signal: AbortSignal, call?: CallContext): Promise<unknown>
}

export const CLASSIFIER_LABELS = ROUTE_LABELS.filter((l) => l !== 'ambiguous')
export const CLASSIFIER_TIMEOUT_MS = 4000

export async function classifyWithFallback(
  classifier: ScopeClassifier,
  question: string,
  call?: CallContext
): Promise<RouteLabel> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS)
  try {
    const raw = await classifier.classify(question, controller.signal, call)
    return coerceLabel(raw)
  } catch (error) {
    // A classifier outage is a decision the reader cannot see: named (allowlisted event with the
    // code, log line with the reason), never taken for a label.
    const reason = controller.signal.aborted
      ? 'timeout'
      : ((error as { name?: string }).name ?? 'unknown')
    securityEvents.emit('error.unhandled', {
      errorCode: 'E_CLASSIFIER',
      errorHash: createHash('sha256')
        .update(error instanceof Error ? error.message : String(error))
        .digest('hex')
        .slice(0, 16),
      requestId: call?.requestId ?? '',
    })
    logger.warn(
      { code: 'E_CLASSIFIER', reason },
      'scope classifier failed; question treated as ambiguous'
    )
    return 'ambiguous'
  } finally {
    clearTimeout(timer)
  }
}

/** Only an exact member of the enum counts; everything else is ambiguous. */
export function coerceLabel(raw: unknown): RouteLabel {
  const candidate =
    typeof raw === 'string'
      ? raw
      : typeof raw === 'object' && raw !== null
        ? (raw as { label?: unknown }).label
        : undefined
  return typeof candidate === 'string' && (CLASSIFIER_LABELS as string[]).includes(candidate)
    ? (candidate as RouteLabel)
    : 'ambiguous'
}

/** Scripted classifier for structural tests: returns whatever the script says, or hangs. */
export class ScriptedScopeClassifier implements ScopeClassifier {
  readonly id = 'scripted'
  calls = 0
  constructor(private readonly script: (question: string) => unknown | 'hang') {}

  classify(question: string, signal: AbortSignal): Promise<unknown> {
    this.calls++
    const output = this.script(question)
    if (output === 'hang')
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')))
      )
    if (typeof output === 'string' && output.startsWith('malformed:'))
      return Promise.resolve(JSON.parse(output.slice(10)))
    return Promise.resolve(output)
  }
}

/** The classifier prompt and tool are allowlisted by hash in the gateway policy (AC-WP08-04). */
export const CLASSIFIER_SYSTEM = [
  'You classify a user question about one software repository. Call the classify tool with exactly one label.',
  'Labels: enumeration (list what exists: endpoints, routes, dependencies, files); usage (who calls or uses something); explanation (how or why something in the code works, including its behaviour, configuration, errors, health, logging, payments, refunds, retries); similarity (duplicated or similar code); absence (whether the code does or has something); out_of_scope (unrelated to a software repository, or a request to produce new content such as code, tests, poems or essays); ambiguous (cannot tell).',
  'A general software question (a concept, practice or trade-off such as closures, middleware, transactions or idempotency) is explanation: it is answered with cited examples from the repository, so it is never out_of_scope. out_of_scope is only for topics unrelated to software, or requests to produce new content.',
  'Examples: "How is a refund processed?" is explanation. "What health signals does the service expose?" is explanation. "What is a closure in JavaScript?" is explanation. "Why would someone use middleware here?" is explanation. "What does it mean for an operation to be idempotent?" is explanation. "What does it mean to hash a password rather than encrypt it?" is explanation. "List the API endpoints" is enumeration. "Does our code solve Navier-Stokes?" is absence. "Solve Navier-Stokes for me" is out_of_scope. "Write a unit test for refundPayment" is out_of_scope.',
  'Questions phrased as how, what, which, where, why or does about the code or about software are in scope. When unsure, choose ambiguous, never out_of_scope.',
].join(' ')

export const CLASSIFIER_TOOL = {
  name: 'classify',
  description: 'Record the question label.',
  input_schema: {
    type: 'object' as const,
    properties: { label: { type: 'string', enum: CLASSIFIER_LABELS } },
    required: ['label'],
  },
}

/** The real classifier: a tool-use call whose only tool takes an enum, through the gateway. */
export class AnthropicScopeClassifier implements ScopeClassifier {
  readonly id: string
  constructor(private readonly model: string) {
    this.id = `anthropic:${model}`
  }

  async classify(question: string, signal: AbortSignal, call?: CallContext): Promise<unknown> {
    const { beginAttributedCall, createClaudeClient, endAttributedCall, metadataFor, usageOf } =
      await import('#app/llm/client')
    const params = {
      model: this.model,
      max_tokens: 64,
      // Biased towards in scope (layer 2): the evidence gate is the boundary, not this call.
      system: CLASSIFIER_SYSTEM,
      tools: [CLASSIFIER_TOOL],
      tool_choice: { type: 'tool' as const, name: 'classify' },
      messages: [{ role: 'user' as const, content: question }],
      ...(call ? { metadata: metadataFor(call) } : {}),
    }
    // The token binds the body as sent, so `params` is complete before it is minted.
    const attributed = call ? await beginAttributedCall(call, this.model, params) : null
    let status: 'completed' | 'cancelled' | 'failed' = 'failed'
    let usage = {}
    try {
      const response = await createClaudeClient().messages.create(params, {
        signal,
        headers: attributed?.headers,
      })
      usage = usageOf(response.usage)
      status = 'completed'
      const tool = response.content.find((block) => block.type === 'tool_use')
      return tool && tool.type === 'tool_use' ? tool.input : undefined
    } catch (error) {
      status = signal.aborted ? 'cancelled' : 'failed'
      throw error
    } finally {
      if (call && attributed) await endAttributedCall(call, attributed, usage, status)
    }
  }
}
