import { normalise } from './normalise.js'
import { PolicyViolation, type OutputRule } from './output_rules.js'

/**
 * Hold-back streaming (design §10): provider SSE frames are forwarded byte
 * for byte, but a frame is released only once every later text within the
 * window has been seen by the rules. The window is at least the longest rule
 * match, so a match split across deltas is caught before any part of it is
 * released. On violation the queue is dropped, one terminal error frame is
 * emitted and nothing follows.
 */
export interface Frame {
  raw: string // the frame bytes as text, including the trailing blank line
  text: string // text contribution (text_delta), '' otherwise
}

/** The earliest SSE event boundary (a blank line) in any valid line-ending form, or null. */
function nextBoundary(s: string): { at: number; len: number } | null {
  let best: { at: number; len: number } | null = null
  for (const [sep, len] of [
    ['\r\n\r\n', 4],
    ['\n\n', 2],
    ['\r\r', 2],
  ] as const) {
    const at = s.indexOf(sep)
    if (at !== -1 && (best === null || at < best.at)) best = { at, len }
  }
  return best
}

export function parseFrames(chunk: string): { frames: Frame[]; rest: string } {
  const frames: Frame[] = []
  let buffer = chunk
  let boundary = nextBoundary(buffer)
  while (boundary) {
    const raw = buffer.slice(0, boundary.at + boundary.len)
    buffer = buffer.slice(boundary.at + boundary.len)
    frames.push({ raw, text: textOf(raw) })
    boundary = nextBoundary(buffer)
  }
  return { frames, rest: buffer }
}

/**
 * The concatenated `data:` payload of an SSE event, or null if it has none. Per the WHATWG SSE grammar
 * a line ends with \n, \r\n or \r; a `data:` line has an OPTIONAL single space before its value; and
 * multiple `data:` lines in one event join with "\n". The guard must read the payload exactly as the
 * provider SDK does, or a frame it misreads is forwarded unscanned.
 */
function dataPayload(raw: string): string | null {
  const parts: string[] = []
  for (const line of raw.split(/\r\n|\r|\n/)) {
    if (line.startsWith('data:')) {
      const value = line.slice(5)
      parts.push(value.startsWith(' ') ? value.slice(1) : value)
    }
  }
  return parts.length ? parts.join('\n') : null
}

function textOf(raw: string): string {
  const payload = dataPayload(raw)
  if (payload === null) return ''
  try {
    const event = JSON.parse(payload) as {
      type?: string
      delta?: { type?: string; text?: string }
    }
    return event.type === 'content_block_delta' && event.delta?.type === 'text_delta'
      ? (event.delta.text ?? '')
      : ''
  } catch {
    // A content-bearing payload the guard cannot parse must NOT be treated as an empty control frame
    // (that forwards it unscanned): return it verbatim so the rules scan it and withhold. Fail closed.
    return payload
  }
}

export interface AsyncOutputRule {
  readonly id: string
  readonly maxMatchLength: number
  assert(text: string): Promise<void> | void
}

type Rule = OutputRule | AsyncOutputRule
const canMask = (r: Rule): r is OutputRule & { mask: NonNullable<OutputRule['mask']> } =>
  typeof (r as OutputRule).mask === 'function'

/** Re-encode a text_delta frame carrying new text, preserving the original event's other fields. */
function textDeltaFrom(rawFrame: string, text: string): string {
  const payload = dataPayload(rawFrame)
  let event: Record<string, unknown> = {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  }
  if (payload !== null) {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>
      event = { ...parsed, delta: { ...(parsed.delta as object), type: 'text_delta', text } }
    } catch {
      // Fall back to the minimal frame above.
    }
  }
  return `event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`
}

export class HoldbackStream {
  private queue: Array<{ frame: Frame; end: number }> = []
  private text = ''
  private violated: PolicyViolation | null = null
  private readonly maskRules: Array<OutputRule & { mask: NonNullable<OutputRule['mask']> }>
  private buffered: Frame[] = []
  private maskedCount = 0
  readonly window: number

  constructor(
    private readonly rules: Array<OutputRule | AsyncOutputRule>,
    minWindow = 128,
    /** Test-only ablation hook: rules see raw text instead of the normalised form. */
    private readonly normaliseText = true,
    /**
     * ADR-0007: redact maskable rules (the URL rule) instead of withholding the whole answer. Off
     * by default so the structural red-team proofs keep their withhold semantics; the gateway turns
     * it on for production egress.
     */
    enableMask = false
  ) {
    this.window = Math.max(minWindow, ...rules.map((r) => r.maxMatchLength))
    this.maskRules = enableMask ? rules.filter(canMask) : []
  }

  /** A masking rule (ADR-0007) redacts instead of withholding, which needs the whole answer. */
  get maskMode(): boolean {
    return this.maskRules.length > 0
  }

  /** How many spans a masking rule redacted (0 until end()); the app renders a notice when > 0. */
  get masked(): number {
    return this.maskedCount
  }

  /** Feeds frames; returns the raw bytes safe to release now. */
  async push(frames: Frame[]): Promise<string> {
    if (this.violated) return ''
    // Masking cannot be done frame-by-frame (a URL split across frames would leak at the release
    // boundary), so a masking stream buffers the whole answer and redacts it at end() (ADR-0007).
    if (this.maskMode) {
      this.buffered.push(...frames)
      return ''
    }
    for (const frame of frames) {
      this.text += this.normaliseText ? normalise(frame.text) : frame.text
      this.queue.push({ frame, end: this.text.length })
      if (frame.text) {
        const scan = this.text.slice(-(this.window + frame.text.length))
        try {
          for (const rule of this.rules) await rule.assert(scan)
        } catch (error) {
          this.violated =
            error instanceof PolicyViolation
              ? error
              : new PolicyViolation('output.rule_error', 'critical')
          this.queue = []
          return ''
        }
      }
    }
    return this.release(this.text.length - this.window)
  }

  /** End of stream: everything held is safe, unless a violation already ended it. */
  async end(): Promise<string> {
    if (this.violated) return ''
    if (this.maskMode) return this.maskedEnd()
    return this.release(Number.POSITIVE_INFINITY)
  }

  /**
   * Redact the buffered answer (ADR-0007). Masking runs on the RAW text (so legitimate non-ASCII
   * content is preserved and plain links are removed), then EVERY rule re-asserts on the normalised
   * masked text — so anything masking could not see (an obfuscated URL, a secret, a foreign
   * honeytoken) still withholds the whole answer, fail-closed. Control frames pass through; the
   * masked text is re-emitted as a single text_delta in the first text frame's place.
   */
  private async maskedEnd(): Promise<string> {
    const rawText = this.buffered.reduce((acc, f) => acc + f.text, '')
    let masked = rawText
    for (const rule of this.maskRules) {
      const result = rule.mask(masked)
      masked = result.text
      this.maskedCount += result.masked
    }
    const scan = this.normaliseText ? normalise(masked) : masked
    try {
      for (const rule of this.rules) await rule.assert(scan)
    } catch (error) {
      this.violated =
        error instanceof PolicyViolation
          ? error
          : new PolicyViolation('output.rule_error', 'critical')
      this.maskedCount = 0
      return ''
    }
    // No span was redacted: no masking rule fired, so the provider stream is unaltered. Release the
    // original frames byte-for-byte to preserve the gateway's passthrough invariant (the rules above
    // still ran on the whole answer, so a secret/honeytoken/obfuscated URL has already withheld).
    if (this.maskedCount === 0) {
      return this.buffered.reduce((acc, f) => acc + f.raw, '')
    }
    let out = ''
    let textEmitted = false
    for (const frame of this.buffered) {
      if (frame.text) {
        if (!textEmitted) {
          out += textDeltaFrom(frame.raw, masked)
          textEmitted = true
        }
      } else {
        out += frame.raw
      }
    }
    if (!textEmitted && masked) out += textDeltaFrom('', masked)
    return out
  }

  get violation(): PolicyViolation | null {
    return this.violated
  }

  private release(upTo: number): string {
    let out = ''
    while (this.queue.length && this.queue[0].end <= upTo) out += this.queue.shift()!.frame.raw
    return out
  }
}

/** The terminal frame emitted after a violation; the app renders a `policy` event from it. */
export function violationFrame(violation: PolicyViolation): string {
  return `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'policy_violation', rule: violation.ruleId } })}\n\n`
}
