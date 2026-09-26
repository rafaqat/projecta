import { OutputBlockedError } from '#app/llm/client'
import type { ModelClient, ModelRequest, ModelStreamEvent } from '#app/assistant/model'

/**
 * A scripted fake model for structural tests (enforcement). Each call consumes the next
 * script entry; a function entry can inspect the request. `hang: true` makes the stream wait until
 * the signal aborts, which is how tests observe upstream cancellation.
 *
 * Substrate (slice 0): the LLM seam the correctness (slice 3) and adversarial (slice 4) eval
 * measurements plug into. It implements the real ModelClient interface, so a slice swaps it in
 * wherever a model is injected, with no real provider call and fully deterministic output.
 */
export type ScriptTurn = ModelStreamEvent[] | ((request: ModelRequest) => ModelStreamEvent[])

export class ScriptedModel implements ModelClient {
  readonly id = 'scripted'
  readonly requests: ModelRequest[] = []
  upstreamAborted = false

  constructor(
    private readonly script: ScriptTurn[],
    private readonly options: { hang?: boolean; delayMs?: number; blockedBy?: string } = {}
  ) {}

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request)
    const turn = this.script[Math.min(this.requests.length - 1, this.script.length - 1)] ?? []
    const events = typeof turn === 'function' ? turn(request) : turn
    if (this.options.hang) {
      if (!signal.aborted) {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true })
        )
      }
      this.upstreamAborted = true
      throw new Error('aborted')
    }
    for (const event of events) {
      if (this.options.delayMs) await new Promise((r) => setTimeout(r, this.options.delayMs))
      if (signal.aborted) {
        this.upstreamAborted = true
        throw new Error('aborted')
      }
      // A scripted gateway block: the stream ends the way the real client reports one.
      if (event.type === 'end' && this.options.blockedBy)
        throw new OutputBlockedError(this.options.blockedBy, null)
      yield event
    }
  }
}

/** A script that asks for `search_code` n times, then answers. */
export function toolLoop(n: number, finalText = 'Done.'): ScriptTurn[] {
  const turns: ScriptTurn[] = []
  for (let i = 0; i < n; i++) {
    turns.push([
      { type: 'tool_use', id: `t${i}`, name: 'search_code', input: { query: `q${i}` } },
      { type: 'end', stopReason: 'tool_use' },
    ])
  }
  turns.push([
    { type: 'text', delta: finalText },
    { type: 'end', stopReason: 'end_turn' },
  ])
  return turns
}
