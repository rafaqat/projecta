/**
 * The answer protocol shared by server and client. This
 * module is pure: no Node imports, so the Inertia client bundles it and both
 * sides agree on the closed event union and its wire format.
 */
export const RUN_STATES = ['running', 'awaiting_input', 'completed', 'cancelled', 'failed'] as const
export type RunState = (typeof RUN_STATES)[number]

export interface SymbolRef {
  path: string
  qualifiedName: string
  kind: string
  span: LineRange
}
export interface LineRange {
  start: number
  end: number
}

export const VIEW_COMPONENTS = [
  'endpoint_table',
  'dependency_graph',
  'flow_trace',
  'clone_class',
  'usage_table',
  'file_outline',
  'repo_map',
  'feature_map',
  'scope_notice',
  'withheld_span',
  'set_progress',
] as const
export type ViewComponent = (typeof VIEW_COMPONENTS)[number]

export type AnswerEvent =
  | { type: 'status'; label: string; runId: string; runState: RunState }
  | { type: 'text'; delta: string; block?: number }
  | { type: 'background'; delta: string }
  | {
      type: 'citation'
      handle: string
      /**
       * The provider's content block, between the orchestrator and the evidence gate only: a
       * citation cites the whole text of its block, and the provider may send it before that
       * text (UAT 2026-09-17). The gate attaches by block and drops the number.
       */
      block?: number
      commitSha: string
      blobSha: string
      spanSha256: string
      symbol: SymbolRef
      span: LineRange
      snippet: string
      precision: 'span' | 'symbol'
      /**
       * Every cited line is comment, not code. Since the lines between statement
       * blocks are shown, a citation can land on a comment: the provenance is true, and what the
       * comment says is the repository's prose, not its behaviour. The reader is told which.
       */
      commentOnly?: boolean
      /**
       * The declaration around an exact span, when it is small (WP-28). A citation of a signature
       * alone is exact and truthful, and reads as cut off — `const checkTitle = () => {` and
       * nothing else (owner, 2026-09-20). Display only: never cited, never hashed (`spanSha256` is
       * over `span`), never verified, and never in the audit decision record, which picks its
       * fields. `start` is the 1-based line of `lines[0]`.
       */
      context?: { start: number; lines: string[] }
      origin: 'repo' | 'dependency' | 'reference'
      /**
       * The cited function's resolved callees in the repository, from the index (       * owner 2026-09-17): a reader can drill into an internal call the answer did not name.
       */
      calls?: Array<{ name: string; path: string; line: number }>
    }
  | { type: 'view'; component: ViewComponent; data: unknown }
  | {
      type: 'verification'
      sentenceId: string
      /**
       * verified: repository entity, cited; dependency: exists only in a locked dependency's API;
       * unverified: uncited or unknown; not_checkable: in the commit's files, but not modelled by the index
       */
      status: 'verified' | 'dependency' | 'unverified' | 'not_checkable'
      detail: string
      /** Where a function described without its code is declared; the mark's pill shows it. */
      where?: Array<{ name: string; path: string; line: number }>
    }
  | { type: 'policy'; rule: string; action: 'blocked' | 'masked' }
  | { type: 'error'; message: string }

export const EVENT_TYPES = [
  'status',
  'text',
  'background',
  'citation',
  'view',
  'verification',
  'policy',
  'error',
] as const
export type EventType = AnswerEvent['type']

export function isAnswerEvent(value: unknown): value is AnswerEvent {
  if (typeof value !== 'object' || value === null) return false
  const type = (value as { type?: unknown }).type
  return typeof type === 'string' && (EVENT_TYPES as readonly string[]).includes(type)
}

/**
 * Wire format: one SSE frame per event, `event:` carrying the type and a
 * single `data:` line holding the JSON. JSON never contains a raw newline,
 * so model text cannot forge a frame boundary.
 */
export function encodeFrame(event: AnswerEvent): string {
  const data = JSON.stringify(event).replace(
    /[\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16)}`
  )
  return `event: ${event.type}\ndata: ${data}\n\n`
}

/** Incremental decoder used by the client and by the fuzz tests. */
export class FrameDecoder {
  private buffer = ''

  push(chunk: string): AnswerEvent[] {
    this.buffer += chunk
    const events: AnswerEvent[] = []
    let boundary = this.buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const frame = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      const event = decodeFrame(frame)
      if (event) events.push(event)
      boundary = this.buffer.indexOf('\n\n')
    }
    return events
  }
}

function decodeFrame(frame: string): AnswerEvent | null {
  let type: string | undefined
  let data: string | undefined
  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) type = line.slice(7)
    else if (line.startsWith('data: ')) data = line.slice(6)
  }
  if (!type || data === undefined) return null
  try {
    const parsed: unknown = JSON.parse(data)
    return isAnswerEvent(parsed) && parsed.type === type ? parsed : null
  } catch {
    return null
  }
}
