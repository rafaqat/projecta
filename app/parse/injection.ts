import {
  ModelServerError,
  modelServerUrl,
  pinnedModel,
  request,
  servedModel,
} from '#app/parse/model_server'
import RE2 from 're2'

/**
 * Texts per /classify request. One forward pass holds the whole batch, so an unbounded
 * one is an unbounded allocation on the server's GPU: a file with hundreds of chunks made the
 * model server ask for 4 GiB and answer 500, failing the ingest (eigenwise-toolshed, 2026-09-20).
 */
export const CLASSIFY_BATCH = 32

/**
 * The minimum model confidence for the positive label to count (recommendation 3 of the
 * 2026-09-24 flagged-chunk review). A floor under the pinned classifier, which returns a top
 * label with no threshold; tune with INJECTION_MIN_SCORE. The rule co-signal below is the
 * primary precision gate — this only trims the low-confidence tail.
 */
export const MIN_SCORE = Number(process.env.INJECTION_MIN_SCORE ?? '0.9')

/**
 * Document-attack detection at ingest (design §4, SEC-28). The interface
 * exposes a boolean only: no score ever leaves the worker, so the badge
 * cannot be used as an oracle for tuning payloads. The result is a signal
 * recorded on the chunk; answers are never blocked on it.
 */
export interface InjectionDetector {
  id: string
  detect(text: string): Promise<boolean>
  /** Resolves the identity (a remote detector's backend) before `id` keys a cache entry. */
  prepare?(): Promise<void>
  /** Several texts in one call, for a detector where the round trip costs more than the model. */
  detectMany?(texts: string[]): Promise<boolean[]>
}

/**
 * Pattern detector: the local default. Matches instruction-shaped text that
 * addresses a model or claims authority over it. Linear time under RE2.
 */
const INSTRUCTION_PATTERNS = [
  'ignore (?:all |any )?(?:previous|prior|above|earlier) (?:instructions|prompts|rules)',
  'disregard (?:all |any )?(?:previous|prior|above) (?:instructions|rules)',
  '(?:you are|act as|pretend to be) (?:now )?(?:an? |the )?(?:new |different )?(?:assistant|ai|model|system)',
  'system prompt',
  '(?:reveal|print|show|output|repeat) (?:your|the) (?:instructions|system prompt|hidden prompt)',
  "(?:do not|don't|never) (?:tell|mention|reveal) (?:this|these|the above) to (?:the )?user",
  '\\bAI assistant\\b.{0,40}\\b(?:must|should|will) (?:now|always)\\b',
  '<\\s*/?\\s*(?:system|assistant|instructions?)\\s*>',
  // Widened 2026-09-24 after the flagged-chunk review: exfiltration and override shapes the model
  // caught but the narrow set missed, each verified to leave the 121 benign false positives at zero.
  '(?:do not|don.t|never) (?:tell|mention|inform|reveal to|notify) (?:the )?user',
  'from now on.{0,60}(?:respond|reply|answer|output|only|ignore|reveal|send)',
  'new (?:directive|instruction|instructions|rule|rules|system prompt)',
  'respond only with',
  '\\b(?:append|send|output|leak|exfiltrate|include|reveal|dump)\\b.{0,40}(?:api[ -]?key|secret|credential|access token|private key|\\.env\\b)',
  'developer mode|jailbreak',
  '(?:reveal|show|print|output|dump).{0,25}(?:the above|all (?:your |the )?(?:instructions|secrets|keys|data))',
].map((p) => new RE2(p, 'i'))

export class RuleInjectionDetector implements InjectionDetector {
  readonly id = 'rules-v1'

  async detect(text: string): Promise<boolean> {
    const normalised = text.normalize('NFKC').replace(/[\u200B-\u200F\u2060\uFEFF]/g, '')
    return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(normalised))
  }
}

/**
 * ONNX classifier detector (Prompt Guard 2 on Azure once its gated weights
 * are approved; any pinned text-classification model locally). The label
 * comparison happens here; callers only ever see the boolean.
 */
export class OnnxInjectionDetector implements InjectionDetector {
  readonly id: string
  private classifier:
    Promise<(text: string) => Promise<Array<{ label: string; score: number }>>> | undefined

  constructor(
    private readonly modelId: string,
    private readonly positiveLabels: string[] = ['INJECTION', 'JAILBREAK'],
    private readonly minScore: number = MIN_SCORE
  ) {
    this.id = `onnx:${modelId}`
  }

  private load() {
    this.classifier ??= (async () => {
      const { env, pipeline } = await import('@huggingface/transformers')
      env.allowRemoteModels = false
      env.localModelPath = process.env.MODELS_DIR ?? 'models'
      const classify = await pipeline('text-classification', this.modelId, { device: 'cpu' })
      return async (text: string) =>
        (await classify(text.slice(0, 2000))) as unknown as Array<{ label: string; score: number }>
    })()
    return this.classifier
  }

  async detect(text: string): Promise<boolean> {
    const classify = await this.load()
    const [top] = await classify(text)
    return (
      top !== undefined &&
      this.positiveLabels.includes(top.label.toUpperCase()) &&
      top.score >= this.minScore
    )
  }
}

/**
 * The model server's classifier. One text per call as the
 * in-process detector; the identity carries the server's backend. An
 * outage surfaces as a thrown ModelServerError, which the callers' existing
 * fail-open path reports as detector.unavailable.
 */
export class RemoteInjectionDetector implements InjectionDetector {
  private identity: Promise<string> | undefined

  constructor(
    private readonly url: string,
    private readonly modelId: string,
    private readonly positiveLabels: string[] = ['INJECTION', 'JAILBREAK'],
    private readonly minScore: number = MIN_SCORE
  ) {}

  get id(): string {
    return this.resolvedId ?? `remote:${this.modelId}`
  }

  private resolvedId: string | undefined

  private async resolve(): Promise<string> {
    this.identity ??= servedModel(this.url, 'classifier', pinnedModel('injection detector'))
      .then((served) => (this.resolvedId = `remote:${this.modelId}:${served.backend}`))
      .catch((error) => {
        this.identity = undefined
        throw error
      })
    return this.identity
  }

  async prepare(): Promise<void> {
    await this.resolve()
  }

  async detect(text: string): Promise<boolean> {
    const [suspected] = await this.detectMany([text])
    return suspected
  }

  async detectMany(texts: string[]): Promise<boolean[]> {
    if (texts.length === 0) return []
    await this.resolve()
    const flags: boolean[] = []
    // In batches: a file's chunks went in one request, and a file with hundreds of them had the
    // server ask its GPU for a 4 GiB allocation and answer 500, failing the ingest (2026-09-20).
    // The round trip is still amortised over a batch; what is bounded is what one forward pass
    // must hold.
    for (let from = 0; from < texts.length; from += CLASSIFY_BATCH) {
      const batch = texts.slice(from, from + CLASSIFY_BATCH)
      const body = await request<{ results: Array<{ label: string; score: number }> }>(
        this.url,
        '/classify',
        { texts: batch.map((t) => t.slice(0, 2000)) }
      )
      if (!Array.isArray(body?.results) || body.results.length !== batch.length)
        throw new ModelServerError(
          'E_MODEL_SERVER_RESPONSE',
          `${this.url}/classify: ${body?.results?.length ?? 'no'} results for ${batch.length} texts`
        )
      for (const r of body.results)
        flags.push(this.positiveLabels.includes(r.label.toUpperCase()) && r.score >= this.minScore)
    }
    return flags
  }
}

/**
 * Precision gate over a model detector (recommendation 2 of the 2026-09-24 flagged-chunk review).
 * The advisory flag stands only when the model AND the rule detector agree: the pinned
 * prompt-injection model flags imperative user-facing prose (validation messages, button labels,
 * "click the button…") as instruction-shaped, which floods the badge with false positives on
 * ordinary UI code; requiring a rule co-signal — an injection shape the RuleInjectionDetector
 * recognises — removes those while keeping classic injections, which match a rule. The flag never
 * blocks an answer, so trading some recall on novel, pattern-free payloads for a usable signal is
 * the right call; the output gate and the "retrieved content is data" system prompt remain the
 * load-bearing defences. Set INJECTION_COSIGNAL=off to fall back to the model alone.
 */
export class PrecisionInjectionDetector implements InjectionDetector {
  private readonly rules = new RuleInjectionDetector()

  constructor(private readonly model: InjectionDetector) {}

  get id(): string {
    return `${this.model.id}+${this.rules.id}`
  }

  async prepare(): Promise<void> {
    await this.model.prepare?.()
  }

  async detect(text: string): Promise<boolean> {
    const [flag] = await this.detectMany([text])
    return flag
  }

  async detectMany(texts: string[]): Promise<boolean[]> {
    if (texts.length === 0) return []
    const modelFlags = this.model.detectMany
      ? await this.model.detectMany(texts)
      : await Promise.all(texts.map((t) => this.model.detect(t)))
    const ruleFlags = await Promise.all(texts.map((t) => this.rules.detect(t)))
    return texts.map((_, i) => modelFlags[i] === true && ruleFlags[i] === true)
  }
}

const detectors = new Map<string, InjectionDetector>()

/**
 * The configured detector, one instance per model id for the life of the
 * process: the classifier loads its weights once, not once per turn or per
 * ingest run.
 */
export function defaultInjectionDetector(): InjectionDetector {
  const configured = process.env.INJECTION_DETECTOR_MODEL ?? ''
  const url = modelServerUrl()
  const cacheKey = url ? `${url} ${configured}` : configured
  let detector = detectors.get(cacheKey)
  if (!detector) {
    const base =
      url && configured
        ? new RemoteInjectionDetector(url, configured)
        : configured
          ? new OnnxInjectionDetector(configured)
          : new RuleInjectionDetector()
    // A model detector is wrapped with the rule co-signal for precision (INJECTION_COSIGNAL=off
    // opts out); the rules-only default is already a rule detector and is used as-is.
    const cosignal = (process.env.INJECTION_COSIGNAL ?? 'on') !== 'off'
    detector = configured && cosignal ? new PrecisionInjectionDetector(base) : base
    detectors.set(cacheKey, detector)
  }
  return detector
}

/**
 * Loads the configured classifier ahead of the first request so no turn or
 * ingest pays for the weights. Failure is reported by the caller's
 * normal path on first use; warm-up itself never throws.
 */
export async function warmInjectionDetector(): Promise<void> {
  try {
    await defaultInjectionDetector().detect('warm-up')
  } catch {
    // The first real call reports the outage with a code (in_process.scoreQuestion).
  }
}
