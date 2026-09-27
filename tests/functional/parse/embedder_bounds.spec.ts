import { test } from '@japa/runner'
import { EMBED_MAX_TOKENS, localEmbedder } from '#app/parse/embedder'

/**
 * The embedder's cost is quadratic in tokens, and characters do not bound
 * tokens: 8,000 characters of code are ~2,500 tokens, 8,000 of Chinese are
 * ~7,000 (batch UAT 2026-09-15, qist/tvbox: two kernel OOM kills at 12 GB
 * after the character cap was in place). So the model reads at most
 * EMBED_MAX_TOKENS of a text, whatever the script.
 */
test.group('embedder bounds (WP-04)', () => {
  test('a text is read up to EMBED_MAX_TOKENS tokens: what follows does not change its vector', async ({
    assert,
  }) => {
    const embedder = await localEmbedder()
    const cjk = '公共の設定を読み込む，返回配置对象。'.repeat(400) // ~6,400 tokens
    const [whole] = await embedder.embed([cjk])
    // A prefix the cap already covers embeds the same; a shorter prefix does not.
    const [long] = await embedder.embed([cjk.slice(0, Math.ceil(cjk.length * 0.75))])
    const [short] = await embedder.embed([cjk.slice(0, 200)])
    const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, v, i) => s + v * b[i], 0)
    assert.closeTo(dot(whole, long), 1, 1e-4, 'past the cap the text is not read')
    assert.isBelow(dot(whole, short), 0.999, 'within the cap it is')
    assert.isAtMost(EMBED_MAX_TOKENS, 2048)
  })
    .tags(['AC-WP04-03', 'wp04'])
    .timeout(120_000)
})
