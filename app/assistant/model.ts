import type { CallContext } from '#app/audit/ledger'

/**
 * The model boundary of the agent loop. The real implementation
 * lives in app/llm/client.ts (INV-01); tests script this interface. Text
 * deltas may carry native search-result citations; the loop never
 * sees provider objects.
 */
export interface SearchResultBlock {
  type: 'search_result'
  source: string // turn-local handle, never a path or SHA
  title: string
  content: Array<{ type: 'text'; text: string }>
}

export interface NativeCitation {
  handle: string
  startBlock: number
  endBlock: number
  citedText: string
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | SearchResultBlock
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result'
      toolUseId: string
      content: Array<{ type: 'text'; text: string } | SearchResultBlock>
    }

export interface ModelMessage {
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ModelRequest {
  system: string
  messages: ModelMessage[]
  tools: ToolSpec[]
  /** `none` keeps the tool definitions (and the cached prefix) but forbids tool use. */
  toolChoice?: 'auto' | 'none'
}

export type ModelStreamEvent =
  | {
      type: 'text'
      delta: string
      citations?: NativeCitation[]
      /** The provider's content block: a citation cites the whole text of its block. */
      block?: number
    }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'end'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' }

export interface ModelClient {
  readonly id: string
  /** `call` attributes the provider call (ledger row, attribution token); fakes ignore it. */
  stream(
    request: ModelRequest,
    signal: AbortSignal,
    call?: CallContext
  ): AsyncIterable<ModelStreamEvent>
}
