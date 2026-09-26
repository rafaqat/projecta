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
    if (
      (block.type === 'tool_result' || block.type === 'search_result') &&
      Array.isArray(block.content)
    )
      for (const inner of block.content as Block[]) yield* walk(inner, role, true)
  }
  for (const message of body.messages ?? []) {
    if (typeof message.content === 'string') continue
    for (const block of message.content) yield* walk(block, message.role, false)
  }
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
  const systemText =
    typeof body.system === 'string'
      ? body.system
      : (body.system ?? []).map((b) => b.text).join('\n')
  if (SECRET_PATTERNS.some((p) => p.test(normalise(systemText)))) reasons.push('inbound.secret')
  for (const { block, role, nested } of textBlocks(body)) {
    if (!nested && !(ALLOWED_BLOCK_TYPES as readonly string[]).includes(block.type))
      reasons.push(`inbound.block_type:${block.type}`)
    if (typeof block.text !== 'string') continue
    const text = normalise(block.text)
    if (SECRET_PATTERNS.some((p) => p.test(text))) reasons.push('inbound.secret')
    // The user's own question and any retrieved or tool text are scored for annotation only.
    if (detector && (role === 'user' || nested)) {
      try {
        if (await detector.score(text)) suspected = true
      } catch {
        detectorFailed = true
      }
    }
    if (options.maskPersonalData !== false && role === 'user' && !nested && block.type === 'text') {
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
