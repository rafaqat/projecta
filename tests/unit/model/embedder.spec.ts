import { test } from '@japa/runner'
import { localEmbedder, embedderIdentity } from '#app/parse/embedder'

/**
 * Substrate check: the embedding model works. Slice 2's robustness measurement drives ingest through
 * this embedder, so the pinned ONNX weights (fetched by `npm run models`, SHA-verified) must load and
 * produce a 768-d vector. This is what "the model works" means for the embedding half of the
 * substrate. Requires the weights present under ./models — the substrate CI job fetches them.
 */
test.group('model/embedder (substrate)', () => {
  test('the embedding model loads its pinned weights and embeds code into 768-d vectors')
    .tags(['model', 'embedder', 'substrate'])
    .timeout(180_000)
    .run(async ({ assert }) => {
      const identity = embedderIdentity()
      assert.equal(identity.dimensions, 768)

      const embedder = await localEmbedder()
      assert.equal(embedder.dimensions, 768)

      const vectors = await embedder.embed([
        'export function add(a: number, b: number) { return a + b }',
        'const greeting = "hello world"',
      ])
      assert.lengthOf(vectors, 2)
      assert.equal(vectors[0]?.length, 768)
      assert.equal(vectors[1]?.length, 768)
      // A real embedding is not all-zero.
      assert.isTrue((vectors[0] ?? new Float32Array()).some((x) => x !== 0))
    })
})
