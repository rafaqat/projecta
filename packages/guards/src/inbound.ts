import { normalise } from './normalise.js'
import { SECRET_PATTERNS } from './output_rules.js'

/**
 * Inbound checks (design §10) over a Messages API request body. Secrets in
 * any content block reject the request (an ingest bug); personal data in
 * user text is masked per policy; unknown content block shapes are
 * rejected; injection in tool results and the user question is annotated
 * only, and a detector outage annotates and continues (ADR-033 §6).
 */
export type Block = { type: string; text?: string; content?: unknown; [k: string]: unknown }
export interface MessagesBody {
  model?: string
  system?: string | Array<{ type: 'text'; text: string }>
  tools?: Array<{ name: string; description?: string; input_schema: unknown }>
  messages?: Array<{ role: string; content: string | Block[] }>
}

export const ALLOWED_BLOCK_TYPES = ['text', 'search_result', 'tool_use', 'tool_result'] as const

export interface InboundDecision {
  decision: 'allow' | 'reject'
  reasons: string[]
  masked: number
  annotations: { injectionSuspected: boolean; detector: string; detectorFailed: boolean }
  body: MessagesBody
}

export interface InjectionDetector {
  id: string
  score(text: string): Promise<boolean> | boolean
}

const PII = [
  { id: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { id: 'phone', pattern: /\+?\d[\d\s().-]{8,}\d/g },
]

/**
 * Every block at every depth: a tool_result may hold search_result blocks whose text sits one
 * level further down, a shape the API accepts whatever the app's own convention. The walk
 * stopped one level short until 2026-09-18 (tests/unit/guards/inbound.spec.ts).
 */
function* textBlocks(
  body: MessagesBody
): Generator<{ block: Block; role: string; nested: boolean }> {
  function* walk(
    block: Block,
    role: string,
    nested: boolean
  ): Generator<{ block: Block; role: string; nested: boolean }> {
    yield { block, role, nested }
    if (block.type === 'tool_result' || block.type === 'search_result') {
      if (Array.isArray(block.content))
        for (const inner of block.content as Block[]) yield* walk(inner, role, true)
      // The API also accepts a plain string for tool_result/search_result content; scan it too
      // (as a nested text block) so a secret or injection in string tool output is not skipped.
      else if (typeof block.content === 'string')
        yield { block: { type: 'text', text: block.content }, role, nested: true }
    }
  }
  for (const message of body.messages ?? []) {
    // A string content is the API's shorthand for a single text block. Normalise it to one in place
    // so a plain-string message gets the SAME secret, injection and PII checks as a block message
    // (the scope classifier sends the user's question as a string), and so PII masking writes back to
    // the content that is forwarded. The provider treats the two shapes identically.
    if (typeof message.content === 'string')
      message.content = [{ type: 'text', text: message.content }]
    for (const block of message.content) yield* walk(block, message.role, false)
  }
}

// Generous bounds on the tool-input walk (legitimate tool arguments are shallow and small): they guard
// against a pathological deeply nested or very wide `input`. They are FAIL-CLOSED — exceeding them does
// not silently skip content (that would forward a secret hidden below the bound exactly as the shallow
// case, now blocked, would not); it marks the input unscannable so the request is rejected.
const INPUT_MAX_DEPTH = 8
const INPUT_MAX_STRINGS = 1000

/**
 * Strings inside a tool call's arguments. Returns false if the walk could not COMPLETE within the
 * bounds — the caller must then fail closed (reject), never forward the unscanned remainder.
 */
function collectInputStrings(value: unknown, out: string[], depth = 0): boolean {
  if (depth > INPUT_MAX_DEPTH) return false
  if (typeof value === 'string') {
    out.push(value)
    return out.length <= INPUT_MAX_STRINGS
  }
  if (Array.isArray(value)) {
    for (const item of value) if (!collectInputStrings(item, out, depth + 1)) return false
    return true
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value))
      if (!collectInputStrings(item, out, depth + 1)) return false
    return true
  }
  return true
}

/**
 * Every provider-visible string on a block: its text, search-result metadata, and tool-call args.
 * `complete` is false when the tool-input walk hit a bound, so the caller rejects rather than forwards.
 */
function provokableStrings(block: Block): { strings: string[]; complete: boolean } {
  const out: string[] = []
  let complete = true
  if (typeof block.text === 'string') out.push(block.text)
  if (block.type === 'search_result') {
    if (typeof block.title === 'string') out.push(block.title)
    if (typeof block.source === 'string') out.push(block.source)
  }
  if (block.type === 'tool_use') complete = collectInputStrings(block.input, out)
  return { strings: out, complete }
}

export async function checkInbound(
  body: MessagesBody,
  options: { detector?: InjectionDetector; maskPersonalData?: boolean } = {}
): Promise<InboundDecision> {
  const reasons: string[] = []
  let masked = 0
  let suspected = false
  let detectorFailed = false
  const detector = options.detector
  // The system prompt and tool descriptions are scanned for secrets but are deliberately NOT pinned
  // to the signed policy: the gateway's boundary is ATTRIBUTION (INV-01 — the app is the sole client,
  // and every request carries a signed attribution token), not a byte-match of app-authored content.
  // So an extra system block or a changed tool description from the legitimate app is expected, and is
  // not treated as an injection: pinning would couple the gateway to the exact prompt/tools and break
  // on every legitimate change, and injection-scoring the app's own trusted system text would only add
  // false "suspected" noise to the decision record (detection is annotate-only). Untrusted text — the
  // user's question, retrieved and tool output — IS scored, below.
  const systemText =
    typeof body.system === 'string'
      ? body.system
      : (body.system ?? []).map((b) => b.text).join('\n')
  if (SECRET_PATTERNS.some((p) => p.test(normalise(systemText)))) reasons.push('inbound.secret')
  for (const { block, role, nested } of textBlocks(body)) {
    // The block-type allowlist holds at EVERY depth: an unknown nested type (e.g. a `document` inside
    // tool_result.content) reaches the provider just as a top-level one would, so it is rejected too.
    if (!(ALLOWED_BLOCK_TYPES as readonly string[]).includes(block.type))
      reasons.push(`inbound.block_type:${block.type}`)
    // Scan every provider-visible string on the block, not only `block.text`: search-result metadata
    // (title/source, which the app builds from repository paths and symbols, so an untrusted repo can
    // influence them) and tool-call arguments (tool_use.input) all reach the provider verbatim.
    const { strings, complete } = provokableStrings(block)
    // Fail closed: a tool input too deep or too wide to fully walk is rejected, never forwarded with
    // the unscanned remainder — otherwise a secret nested below the bound would pass unseen.
    if (!complete) reasons.push('inbound.tool_input_unscannable')
    for (const raw of strings) {
      const text = normalise(raw)
      if (SECRET_PATTERNS.some((p) => p.test(text))) reasons.push('inbound.secret')
      // The user's own question and any retrieved or tool text are scored for annotation only.
      if (detector && (role === 'user' || nested)) {
        try {
          if (await detector.score(text)) suspected = true
        } catch {
          detectorFailed = true
        }
      }
    }
    if (
      options.maskPersonalData !== false &&
      role === 'user' &&
      !nested &&
      block.type === 'text' &&
      typeof block.text === 'string'
    ) {
      let replaced = block.text
      for (const rule of PII) {
        replaced = replaced.replace(rule.pattern, () => {
          masked++
          return `[${rule.id} masked]`
        })
      }
      block.text = replaced
    }
  }
  return {
    decision: reasons.length ? 'reject' : 'allow',
    reasons: Array.from(new Set(reasons)),
    masked,
    annotations: {
      injectionSuspected: suspected,
      detector: detector?.id ?? 'none',
      detectorFailed,
    },
    body,
  }
}

/** The gateway's default detector: instruction-shaped text (the same patterns as the app's rules-v1). */
const INSTRUCTION_PATTERNS = [
  /ignore (?:all |any )?(?:previous|prior|above|earlier) (?:instructions|prompts|rules)/i,
  /disregard (?:all |any )?(?:previous|prior|above) (?:instructions|rules)/i,
  /(?:you are|act as|pretend to be) (?:now )?(?:an? |the )?(?:new |different )?(?:assistant|ai|model|system)/i,
  /(?:reveal|print|show|output|repeat) (?:your|the) (?:instructions|system prompt|hidden prompt)/i,
  /<\s*\/?\s*(?:system|assistant|instructions?)\s*>/i,
]
export const ruleDetector: InjectionDetector = {
  id: 'rules-v1',
  score: (text) => INSTRUCTION_PATTERNS.some((p) => p.test(text)),
}
