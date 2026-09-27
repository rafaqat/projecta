import { readFileSync } from 'node:fs'
import app from '@adonisjs/core/services/app'
import type { Tensor } from '@huggingface/transformers'
import { ModelServerError, modelServerUrl, request, servedModel } from '#app/parse/model_server'

/**
 * Embeddings (SEC-24). The model is the one pinned in
 * models.lock.json, loaded from the local models directory only; remote
 * downloads are disabled so a missing file is a build failure, never a
 * runtime fetch. The embedder ID (model id, revision, file) is part of every
 * embedding cache key and of configHash.
 */
export interface EmbedderIdentity {
  modelId: string
  revision: string
  file: string
  dimensions: number
}

interface ModelLock {
  models: Array<{
    id: string
    purpose: string
    revision: string
    files: Array<{ path: string; sha256?: string }>
  }>
}

export function embedderIdentity(): EmbedderIdentity {
  const lock = JSON.parse(readFileSync(app.makePath('models.lock.json'), 'utf8')) as ModelLock
  const model = lock.models.find((m) => m.purpose.startsWith('code embeddings'))
  if (!model) throw new Error('models.lock.json has no code embedding model')
  const file = model.files.find((f) => f.path.endsWith('.onnx'))?.path ?? 'onnx/model.onnx'
  return { modelId: model.id, revision: model.revision, file, dimensions: 768 }
}

export function embedderId(identity = embedderIdentity()): string {
  return `${identity.modelId}@${identity.revision.slice(0, 12)}:${identity.file}`
}

export interface Embedder {
  id: string
  dimensions: number
  embed(texts: string[]): Promise<Float32Array[]>
}

let instance: Promise<Embedder> | undefined

/**
 * Tokens the model reads of one text. Its limit is 8,192, and attention
 * memory is quadratic in the length: a text at the limit held ~10 GB in the
 * ONNX arena and the worker was killed. Characters do not bound tokens
 * (8,000 of code ≈ 2,500 tokens, 8,000 of Chinese ≈ 7,000; batch UAT
 * 2026-09-15, qist/tvbox), so the tokenizer truncates here, and the vector
 * of a longer chunk stands for its first 2,048 tokens.
 */
export const EMBED_MAX_TOKENS = 2048

export function localEmbedder(): Promise<Embedder> {
  instance ??= (async () => {
    const identity = embedderIdentity()
    const {
      env,
      AutoTokenizer,
      AutoModel,
      mean_pooling: meanPooling,
    } = await import('@huggingface/transformers')
    env.allowRemoteModels = false
    env.localModelPath = process.env.MODELS_DIR ?? app.makePath('models')
    const dtype = identity.file.includes('quantized')
      ? 'q8'
      : identity.file.includes('fp16')
        ? 'fp16'
        : 'fp32'
    const tokenizer = await AutoTokenizer.from_pretrained(identity.modelId)
    const model = await AutoModel.from_pretrained(identity.modelId, {
      dtype,
      device: 'cpu',
      // No arena: ONNX Runtime's arena keeps the largest batch ever seen resident for the
      // life of the process (a worker sat at 11.8 GB idle, UAT 2026-09-14); without it the
      // memory of a batch goes back to the OS when the batch is done.
      session_options: { enableCpuMemArena: false },
    })
    return {
      id: embedderId(identity),
      dimensions: identity.dimensions,
      async embed(texts) {
        if (texts.length === 0) return []
        // The feature-extraction pipeline, with the token cap the pipeline does not expose.
        const inputs = tokenizer(texts, {
          padding: true,
          truncation: true,
          max_length: EMBED_MAX_TOKENS,
        })
        const outputs = (await model(inputs)) as { last_hidden_state: Tensor }
        const pooled = meanPooling(outputs.last_hidden_state, inputs.attention_mask).normalize(
          2,
          -1
        )
        const width = pooled.dims[1]
        const data = pooled.data as Float32Array
        return texts.map((_, i) => data.slice(i * width, (i + 1) * width))
      },
    }
  })()
  return instance
}

/**
 * The embedder for this process: the model server when
 * MODEL_SERVER_URL is set, in-process ONNX otherwise. Web and worker both
 * go through here, so query vectors and index vectors come from one model.
 */
export function defaultEmbedder(): Promise<Embedder> {
  const url = modelServerUrl()
  return url ? remoteEmbedder(url) : localEmbedder()
}

const remotes = new Map<string, Promise<Embedder>>()

/** The server's embedder, its identity `<model>@<revision>:<backend>` once the revision is checked. */
export function remoteEmbedder(url: string): Promise<Embedder> {
  let pending = remotes.get(url)
  if (!pending) {
    pending = (async () => {
      const identity = embedderIdentity()
      const served = await servedModel(url, 'embedder', {
        id: identity.modelId,
        revision: identity.revision,
      })
      const embedder: Embedder = {
        id: `${identity.modelId}@${identity.revision.slice(0, 12)}:${served.backend}`,
        dimensions: identity.dimensions,
        async embed(texts) {
          if (texts.length === 0) return []
          const body = await request<{ vectors: number[][] }>(url, '/embed', { texts })
          if (!Array.isArray(body?.vectors) || body.vectors.length !== texts.length)
            throw new ModelServerError(
              'E_MODEL_SERVER_RESPONSE',
              `${url}/embed: ${body?.vectors?.length ?? 'no'} vectors for ${texts.length} texts`
            )
          return body.vectors.map((v) => Float32Array.from(v))
        },
      }
      return embedder
    })().catch((error) => {
      remotes.delete(url)
      throw error
    })
    remotes.set(url, pending)
  }
  return pending
}

/** pgvector text literal for a halfvec column. */
export function toVectorLiteral(vector: Float32Array): string {
  return `[${Array.from(vector, (v) => v.toFixed(6)).join(',')}]`
}

/** Texts per model call, at most; the padded-size budget below is what usually caps a batch. */
export const EMBED_BATCH_SIZE = 16

/**
 * Characters of one text the embedder reads. jina-embeddings-v2 accepts
 * 8,192 tokens, but attention memory is quadratic in the length: one text at
 * the cap held about 10 GB resident in the ONNX arena for the life of the
 * process (UAT 2026-09-14). Chunks are cut at MAX_CHUNK_CHARS (1,800); a
 * longer one is a single block-less symbol spanning thousands of lines, and
 * its head is what the vector stands for. The lexical index holds all of it.
 */
export const EMBED_MAX_CHARS = 8_000

/**
 * Padded characters per batch (count × longest text): the bound is on size,
 * not count. Eight ordinary chunks, or two at EMBED_MAX_CHARS.
 */
export const EMBED_BATCH_CHARS = 16_000

/**
 * Remote (model-server) batching. The caps above guard the in-process ONNX arena's quadratic
 * attention memory on the worker's own CPU. The model server holds the model itself (fp16 on its
 * own device) and manages its own batch memory, so the client can feed it larger batches and keep
 * several in flight, so the device is not starved and idling between small, serial round-trips.
 * These bounds are on the request shape, not on the server's memory, and never apply in-process.
 */
export const EMBED_REMOTE_BATCH_SIZE = 64
export const EMBED_REMOTE_BATCH_CHARS = 64_000
export const EMBED_REMOTE_CONCURRENCY = 3

export interface EmbedBatchOptions {
  batchSize?: number
  batchChars?: number
  maxChars?: number
  /** Batches allowed in flight at once. 1 keeps the strictly-serial in-process behaviour. */
  concurrency?: number
}

/**
 * Batching bounds for the backend actually in use: the model server gets the larger remote caps
 * and concurrency; the in-process embedder keeps the small, serial caps that hold its arena down.
 * The URL is resolved the same way defaultEmbedder chooses its backend, so the two never disagree.
 */
export function embedBatchOptions(url = modelServerUrl()): Required<EmbedBatchOptions> {
  return url
    ? {
        batchSize: EMBED_REMOTE_BATCH_SIZE,
        batchChars: EMBED_REMOTE_BATCH_CHARS,
        maxChars: EMBED_MAX_CHARS,
        concurrency: EMBED_REMOTE_CONCURRENCY,
      }
    : {
        batchSize: EMBED_BATCH_SIZE,
        batchChars: EMBED_BATCH_CHARS,
        maxChars: EMBED_MAX_CHARS,
        concurrency: 1,
      }
}

/**
 * Embeds in batches bounded by padded size, longest first so a batch holds
 * texts of similar length, returning the vectors in input order. An
 * unbounded batch of one file's chunks reached 12 GB, and sixteen texts at
 * the model's cap reached 10 GB, and the worker was killed (UAT 2026-09-14).
 * With concurrency > 1 the batches are formed the same way, then run up to
 * `concurrency` at a time (for the model server); concurrency 1 is the
 * strictly-serial path, byte-for-byte the previous behaviour.
 */
export async function embedInBatches(
  embedder: Pick<Embedder, 'embed'>,
  texts: string[],
  {
    batchSize = EMBED_BATCH_SIZE,
    batchChars = EMBED_BATCH_CHARS,
    maxChars = EMBED_MAX_CHARS,
    concurrency = 1,
  }: EmbedBatchOptions = {}
): Promise<Float32Array[]> {
  const cut = texts.map((t) => (t.length > maxChars ? t.slice(0, maxChars) : t))
  const order = cut.map((_, i) => i).sort((a, b) => cut[b].length - cut[a].length)
  const out: Float32Array[] = new Array(texts.length)
  // Form the batches first (longest-first, bounded by count and padded size), unchanged from before.
  const batches: number[][] = []
  let start = 0
  while (start < order.length) {
    // The first text is the longest of the batch, so it sets the padded width.
    const width = Math.max(cut[order[start]].length, 1)
    let end = start + 1
    while (end < order.length && end - start < batchSize && (end - start + 1) * width <= batchChars)
      end++
    batches.push(order.slice(start, end))
    start = end
  }
  const runBatch = async (indices: number[]) => {
    const vectors = await embedder.embed(indices.map((i) => cut[i]))
    for (const [j, i] of indices.entries()) out[i] = vectors[j] // written by input index: order-safe
  }
  if (concurrency <= 1) {
    for (const indices of batches) await runBatch(indices)
  } else {
    // A bounded pool: each worker claims the next batch (next++ is atomic between awaits) until done.
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
        while (next < batches.length) await runBatch(batches[next++])
      })
    )
  }
  return out
}
