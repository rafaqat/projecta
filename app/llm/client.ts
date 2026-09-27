import logger from '@adonisjs/core/services/logger'
import { createHash } from 'node:crypto'
import { DECISIONS_HEADER, decodeDecisions } from '#guards/index'
import { securityEvents } from '#app/security/events/index'
import Anthropic from '@anthropic-ai/sdk'
import env from '#start/env'
import type { ModelClient, ModelMessage } from '#app/assistant/model'
import {
  openLedgerRow,
  updateLedgerRow,
  type CallContext,
  type CallStatus,
  type Usage,
} from '#app/audit/ledger'
import { mintAttributionToken } from '#app/security/attribution'
import { configHash } from '#app/audit/config_hash'

/**
 * The only module that imports the provider SDK (INV-01). The base
 * URL is llm-gateway in every environment; the "API key" is the gateway's
 * shared token, never a provider credential. Provider selection belongs to
 * the gateway's route table.
 */
let client: Anthropic | undefined

export interface ClientOverrides {
  baseURL?: string
  apiKey?: string
}

function newClient(overrides: ClientOverrides = {}): Anthropic {
  return new Anthropic({
    baseURL: overrides.baseURL ?? env.get('ANTHROPIC_BASE_URL'),
    apiKey: overrides.apiKey ?? env.get('LLM_GATEWAY_TOKEN').release(),
    maxRetries: 1,
    timeout: 20_000,
  })
}

/** The shared client for the configured gateway; the first caller's overrides configure it. */
export function createClaudeClient(overrides: ClientOverrides = {}): Anthropic {
  client ??= newClient(overrides)
  return client
}

/** Model IDs are configuration (part of configHash), never literals in call sites. */
export const MODELS = {
  scopeClassifier: process.env.SCOPE_CLASSIFIER_MODEL ?? 'claude-haiku-4-5-20251001',
  // Owner decision 2026-09-12: the agent loop runs on the cheap model; ANSWER_MODEL overrides.
  answer: process.env.ANSWER_MODEL ?? 'claude-haiku-4-5-20251001',
} as const

/**
 * Every provider call is attributed (design §8): a request-bound token in
 * the x-attribution header and one llm_usage row opened before the call and
 * closed with its status, including cancellation. The provider sees the
 * internal user id as metadata.user_id, never an email.
 */
export interface AttributedCall {
  headers: Record<string, string>
  metadata: { user_id: string }
  ledgerId: string
}

/**
 * The token binds the request body byte-for-byte, so `body` must
 * be what the SDK serialises: callers pass the parameters as sent, with
 * `metadata` already set and, for `.stream()`, `stream: true`.
 */
export async function beginAttributedCall(
  ctx: CallContext,
  model: string,
  body: unknown
): Promise<AttributedCall> {
  const { token, jti } = await mintAttributionToken(ctx.signer ?? 'web', {
    sub: String(ctx.userId),
    workspace: ctx.workspaceId,
    purpose: ctx.purpose,
    body,
  })
  const ledgerId = await openLedgerRow(ctx, model, jti)
  return {
    // The gateway checks the configuration this answer was produced under.
    headers: { 'x-attribution': token, 'x-config-hash': configHash().hash },
    metadata: metadataFor(ctx),
    ledgerId,
  }
}

/** The provider sees the internal user id, never an email (design §8). */
export function metadataFor(ctx: CallContext): { user_id: string } {
  return { user_id: String(ctx.userId) }
}

export function usageOf(usage: Anthropic.Usage | null | undefined): Usage {
  if (!usage) return {}
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? undefined,
  }
}

export async function endAttributedCall(
  ctx: CallContext,
  call: AttributedCall,
  usage: Usage,
  status: CallStatus
) {
  await updateLedgerRow(ctx, call.ledgerId, usage, status)
}

/** The gateway blocked the answer on an output rule; the turn reports the rule as a policy event. */
export class OutputBlockedError extends Error {
  readonly code = 'E_OUTPUT_BLOCKED'
  constructor(
    readonly rule: string,
    readonly cause: unknown
  ) {
    super(`output blocked by ${rule}`)
  }
}

/**
 * The ModelClient adapter for the agent loop. Search
 * results go out as native search-result blocks with citations enabled;
 * streamed citation deltas come back as turn-local handles and block
 * indices, never as provider objects. Handles are the `source` field.
 */
export function createModelClient(model = MODELS.answer, overrides?: ClientOverrides): ModelClient {
  // Overrides build a private client (tests, probes) and leave the shared one untouched.
  const anthropic = overrides ? newClient(overrides) : createClaudeClient()
  return {
    id: model,
    async *stream(request, signal, call) {
      const params: Anthropic.MessageStreamParams = {
        model,
        max_tokens: 2048,
        // Prompt caching: the static prompt and the turn's evidence are resent on every tool round.
        system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
        tools: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
        })),
        messages: withEvidenceCache(request.messages.map(toProviderMessage)),
      }
      if (call) params.metadata = metadataFor(call)
      // `.stream()` adds `stream: true` on the wire; the token must cover that body.
      const attributed = call
        ? await beginAttributedCall(call, model, { ...params, stream: true })
        : null
      let status: CallStatus = 'failed'
      let usage: Usage = {}
      try {
        // Inside the try: a synchronous throw from `.stream()` (malformed params, SDK validation)
        // still runs the finally that closes the ledger row opened just above, so a failed provider
        // call never leaves an open/incomplete row behind (spend reconciliation).
        const stream = anthropic.messages.stream(params, { signal, headers: attributed?.headers })
        // The gateway's inbound summary rides a response header. Its outbound half is a
        // frame the provider SDK drops: the SDK yields only the event types it lists, so the frame
        // reaches a direct HTTP client and the conformance corpus but never this adapter. What the
        // gateway blocked still arrives, as the policy_violation frame the catch below reads.
        if (call?.onGatewayDecisions) {
          void stream
            .withResponse()
            .then(({ response }) => {
              const decisions = decodeDecisions(response.headers.get(DECISIONS_HEADER))
              if (decisions) call.onGatewayDecisions!(decisions)
            })
            .catch(() => undefined)
        }
        // Tool-use input arrives as JSON fragments; it is assembled per block and parsed at block stop.
        const pending = new Map<number, { id: string; name: string; json: string }>()
        for await (const event of stream) {
          if (event.type === 'message_start') {
            usage = usageOf(event.message.usage) // input tokens are known here, before any output
            if (call && attributed) await updateLedgerRow(call, attributed.ledgerId, usage)
          } else if (
            event.type === 'content_block_start' &&
            event.content_block.type === 'tool_use'
          ) {
            pending.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              json: '',
            })
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta')
              yield { type: 'text', delta: event.delta.text, block: event.index }
            else if (event.delta.type === 'input_json_delta') {
              const block = pending.get(event.index)
              if (block) block.json += event.delta.partial_json
            } else if (event.delta.type === 'citations_delta') {
              const c = event.delta.citation
              if (c.type === 'search_result_location') {
                if (c.end_block_index - 1 > 32)
                  logger.warn(
                    { raw: JSON.stringify({ ...c, cited_text: `${c.cited_text.length} chars` }) },
                    'citation with a large block index'
                  )
                // end_block_index is exclusive in the provider's schema; the loop uses inclusive ranges.
                yield {
                  type: 'text',
                  delta: '',
                  block: event.index,
                  citations: [
                    {
                      handle: c.source,
                      startBlock: c.start_block_index,
                      endBlock: c.end_block_index - 1,
                      citedText: c.cited_text,
                    },
                  ],
                }
              }
            }
          } else if (event.type === 'content_block_stop') {
            const block = pending.get(event.index)
            if (block) {
              pending.delete(event.index)
              let input: unknown = {}
              try {
                input = block.json ? JSON.parse(block.json) : {}
              } catch {
                // The model's tool arguments were not JSON: the tool runs with none, and says so.
                securityEvents.emit('error.unhandled', {
                  errorCode: 'E_TOOL_INPUT',
                  errorHash: createHash('sha256')
                    .update(block.json ?? '')
                    .digest('hex')
                    .slice(0, 16),
                  requestId: call?.requestId ?? '',
                })
                logger.warn(
                  { code: 'E_TOOL_INPUT', tool: block.name, bytes: block.json?.length ?? 0 },
                  'tool input was not JSON'
                )
                input = {}
              }
              yield { type: 'tool_use', id: block.id, name: block.name, input }
            }
          }
        }
        const final = await stream.finalMessage()
        usage = usageOf(final.usage)
        status = 'completed'
        yield {
          type: 'end',
          stopReason:
            final.stop_reason === 'tool_use'
              ? 'tool_use'
              : final.stop_reason === 'max_tokens'
                ? 'max_tokens'
                : 'end_turn',
        }
      } catch (error) {
        status = signal.aborted ? 'cancelled' : 'failed'
        // The gateway ended the stream on an output rule: a decision the reader is told, not a failure.
        // The SDK carries the frame as `error.error` = { type: 'error', error: { type, rule } }.
        const frame = (error as { error?: { error?: { type?: string; rule?: string } } }).error
        if (frame?.error?.type === 'policy_violation')
          throw new OutputBlockedError(frame.error.rule ?? 'output', error)
        throw error
      } finally {
        if (call && attributed) await endAttributedCall(call, attributed, usage, status)
      }
    },
  }
}

/**
 * Prompt-cache breakpoints: one after the first user message (system, tools
 * and the turn's evidence) and a moving one after the latest user message,
 * so each tool round reuses everything before it. Small models need a
 * prefix of several thousand tokens before the first breakpoint takes.
 */
function withEvidenceCache(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const users = messages.filter((m) => m.role === 'user')
  for (const message of new Set([users[0], users.at(-1)])) {
    if (!message || typeof message.content === 'string' || message.content.length === 0) continue
    const last = message.content.length - 1
    message.content[last] = {
      ...message.content[last],
      cache_control: { type: 'ephemeral' },
    } as Anthropic.ContentBlockParam
  }
  return messages
}

export function toProviderMessage(message: ModelMessage): Anthropic.MessageParam {
  return {
    role: message.role,
    content: message.content.map((block): Anthropic.ContentBlockParam => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text }
        case 'search_result':
          return {
            type: 'search_result',
            source: block.source,
            title: block.title,
            content: block.content,
            citations: { enabled: true },
          }
        case 'tool_use':
          return {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          }
        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: block.toolUseId,
            content: block.content.map((c) =>
              c.type === 'text'
                ? { type: 'text' as const, text: c.text }
                : {
                    type: 'search_result' as const,
                    source: c.source,
                    title: c.title,
                    content: c.content,
                    citations: { enabled: true },
                  }
            ),
          }
      }
    }),
  }
}
