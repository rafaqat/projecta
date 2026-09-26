/**
 * Strict state machine for the prompt contract's tags (design §6).
 * The model's text may contain `<general>…</general>` background segments
 * and the self-closing markers `<out_of_scope/>` (decline) and
 * `<no_instance/>` (no instance of a software concept in the evidence). Tags may be split
 * across deltas, nesting is not allowed, and an unterminated `<general>`
 * closes at end of stream as background: it never leaks into repository
 * claims. Anything that is not exactly a known tag is ordinary text, and
 * everything inside a ``` fence is: quoted repository content that contains
 * the tokens as literals never opens a segment (WP-19, BL-11).
 */
export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'general'; text: string }
  | { kind: 'decline' }
  /** The model found no instance of a software concept in the evidence (WP-19); the gate renders the deterministic notice. */
  | { kind: 'no_instance' }

const OPEN = '<general>'
const CLOSE = '</general>'
const DECLINE = '<out_of_scope/>'
const NO_INSTANCE = '<no_instance/>'
const TAGS = [OPEN, CLOSE, DECLINE, NO_INSTANCE]
const FENCE = '```'

/** Backticks at the end of a buffer that could begin a fence in the next delta. */
function trailingBackticks(buffer: string): number {
  let n = 0
  while (n < FENCE.length - 1 && buffer[buffer.length - 1 - n] === '`') n++
  return n
}

export class GeneralParser {
  private inGeneral = false
  private inFence = false
  private pending = ''

  feed(delta: string): Segment[] {
    const out: Segment[] = []
    let buffer = this.pending + delta
    this.pending = ''
    while (buffer.length > 0) {
      const fence = buffer.indexOf(FENCE)
      if (this.inFence) {
        if (fence === -1) {
          const keep = trailingBackticks(buffer)
          this.emit(out, buffer.slice(0, buffer.length - keep))
          this.pending = buffer.slice(buffer.length - keep)
          return out
        }
        this.emit(out, buffer.slice(0, fence + FENCE.length))
        buffer = buffer.slice(fence + FENCE.length)
        this.inFence = false
        continue
      }
      const lt = buffer.indexOf('<')
      if (fence !== -1 && (lt === -1 || fence < lt)) {
        this.emit(out, buffer.slice(0, fence + FENCE.length))
        buffer = buffer.slice(fence + FENCE.length)
        this.inFence = true
        continue
      }
      if (lt === -1) {
        const keep = trailingBackticks(buffer)
        this.emit(out, buffer.slice(0, buffer.length - keep))
        this.pending = buffer.slice(buffer.length - keep)
        return out
      }
      if (lt > 0) this.emit(out, buffer.slice(0, lt))
      buffer = buffer.slice(lt)
      const tag = TAGS.find((t) => buffer.startsWith(t))
      if (
        tag === DECLINE ||
        tag === NO_INSTANCE ||
        (tag === OPEN && !this.inGeneral) ||
        (tag === CLOSE && this.inGeneral)
      ) {
        buffer = buffer.slice(tag.length)
        if (tag === DECLINE) out.push({ kind: 'decline' })
        else if (tag === NO_INSTANCE) out.push({ kind: 'no_instance' })
        else this.inGeneral = tag === OPEN
        continue
      }
      // A stray close or a nested open is not a tag here: it is literal text.
      if (tag) {
        this.emit(out, tag)
        buffer = buffer.slice(tag.length)
        continue
      }
      if (TAGS.some((t) => t.startsWith(buffer))) {
        this.pending = buffer // possible tag split across deltas
        return out
      }
      this.emit(out, '<')
      buffer = buffer.slice(1)
    }
    return out
  }

  /** End of stream: a partial tag or fence is literal text; an open segment closes as background. */
  end(): Segment[] {
    const out: Segment[] = []
    if (this.pending) this.emit(out, this.pending)
    this.pending = ''
    this.inGeneral = false
    this.inFence = false
    return out
  }

  private emit(out: Segment[], text: string) {
    if (!text) return
    const kind = this.inGeneral ? 'general' : 'text'
    const last = out[out.length - 1]
    if (last && last.kind === kind) last.text += text
    else out.push({ kind, text })
  }
}
