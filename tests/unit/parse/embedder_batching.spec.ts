import { test } from '@japa/runner'
import {
  EMBED_BATCH_SIZE,
  EMBED_REMOTE_BATCH_SIZE,
  EMBED_REMOTE_CONCURRENCY,
  embedBatchOptions,
  embedInBatches,
  type Embedder,
} from '#app/parse/embedder'

/**
 * embedInBatches is pure orchestration over an Embedder, so a fake embedder tests the parts that
 * matter without loading the model: the vectors come back in INPUT order however the batches are
 * formed or run, the batch caps (count and padded size) are respected, and running several batches
 * in flight (the model-server path) never reorders the result. The oracle is the input index encoded
 * into each text ('7' -> vector [7]); nothing here calls the real embedder.
 */
function fakeEmbedder(opts: { delayMs?: number } = {}) {
  const batches: string[][] = []
  let active = 0
  let maxActive = 0
  const embedder: Pick<Embedder, 'embed'> = {
    async embed(texts) {
      active += 1
      maxActive = Math.max(maxActive, active)
      batches.push([...texts])
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
      active -= 1
      // The text is a number; its vector is that number, so out[i] is verifiable against input i.
      return texts.map((t) => Float32Array.from([Number(t)]))
    },
  }
  return {
    embedder,
    batches,
    get maxActive() {
      return maxActive
    },
  }
}

test.group('parse/embedder batching', () => {
  test('returns vectors in input order, serial (concurrency 1)', async ({ assert }) => {
    const texts = Array.from({ length: 20 }, (_, i) => String(i))
    const { embedder } = fakeEmbedder()
    const out = await embedInBatches(embedder, texts, { batchSize: 4, concurrency: 1 })
    assert.deepEqual(
      out.map((v) => v[0]),
      texts.map(Number),
      'each output is the vector of the text at the same index'
    )
  }).tags(['embedder', 'batching'])

  test('preserves input order even with batches in flight (concurrency > 1)', async ({
    assert,
  }) => {
    const texts = Array.from({ length: 30 }, (_, i) => String(i))
    const fake = fakeEmbedder({ delayMs: 5 })
    const out = await embedInBatches(fake.embedder, texts, { batchSize: 1, concurrency: 4 })
    assert.deepEqual(
      out.map((v) => v[0]),
      texts.map(Number),
      'order is by input index, not completion'
    )
    // With one text per batch, 30 batches and a delay, the pool should run several at once.
    assert.isAtLeast(fake.maxActive, 2, 'more than one batch was in flight')
  }).tags(['embedder', 'batching'])

  test('no batch exceeds the count or padded-size caps', async ({ assert }) => {
    // Ten equal-length (25-char) texts, cap 4 by count and 100 by padded size (count x longest).
    const texts = Array.from({ length: 10 }, (_, i) => String(i).padStart(25, '0'))
    const { embedder, batches } = fakeEmbedder()
    const out = await embedInBatches(embedder, texts, {
      batchSize: 4,
      batchChars: 100,
      concurrency: 2,
    })
    for (const b of batches) {
      assert.isAtMost(b.length, 4, 'count cap held')
      const longest = Math.max(...b.map((t) => t.length))
      assert.isAtMost(b.length * longest, 100, 'padded-size cap held')
    }
    assert.deepEqual(
      out.map((v) => v[0]),
      texts.map(Number),
      'still in order'
    )
  }).tags(['embedder', 'batching'])

  test('a single text over the padded cap is still embedded (a batch of one)', async ({
    assert,
  }) => {
    const { embedder, batches } = fakeEmbedder()
    const out = await embedInBatches(embedder, ['7'], { batchChars: 0, maxChars: 8000 })
    assert.lengthOf(out, 1)
    assert.equal(out[0][0], 7)
    assert.deepEqual(batches, [['7']], 'the one text is sent alone rather than dropped')
  }).tags(['embedder', 'batching'])

  test('embedBatchOptions picks remote caps + concurrency only when a server URL is set', ({
    assert,
  }) => {
    const remote = embedBatchOptions('http://host.docker.internal:8765')
    assert.equal(remote.concurrency, EMBED_REMOTE_CONCURRENCY)
    assert.equal(remote.batchSize, EMBED_REMOTE_BATCH_SIZE)
    assert.isAbove(remote.concurrency, 1, 'the remote path runs batches in flight')

    const local = embedBatchOptions('')
    assert.equal(local.concurrency, 1, 'the in-process path stays strictly serial')
    assert.equal(local.batchSize, EMBED_BATCH_SIZE, 'and keeps the small arena-safe cap')
  }).tags(['embedder', 'batching'])
})
