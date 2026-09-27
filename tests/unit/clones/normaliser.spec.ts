import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { alignTokens } from '#app/clones/alignment'
import { minHash, lshBands } from '#app/clones/minhash'
import { normalise, symbolTokens, type SymbolTokens } from '#app/clones/tokens'

const FIXTURE = 'evals/fixtures/clone-fixture'

async function fixtureSymbols(): Promise<Map<string, SymbolTokens>> {
  const out = new Map<string, SymbolTokens>()
  for (const file of ['src/orders_a.ts', 'src/orders_b.ts', 'src/refunds.ts']) {
    const content = await readFile(`${FIXTURE}/${file}`, 'utf8')
    for (const s of await symbolTokens(file, content)) out.set(s.qualifiedName, s)
  }
  return out
}

test.group('clone normaliser, MinHash and alignment (design §7)', () => {
  test('a destructuring declaration is named by its first bound name, never the pattern text', async ({
    assert,
  }) => {
    // The fixture's 40-name export (batch UAT 2026-09-14) made a 700-character clone-signature name.
    const [s] = await symbolTokens(
      'src/config/flags.ts',
      'export const { FREE_SHIPPING_THRESHOLD, GIFT_WRAP_ENABLED, ...rest } = loadFlags()\n'
    )
    assert.equal(s.name, 'FREE_SHIPPING_THRESHOLD')
    assert.equal(s.qualifiedName, 'FREE_SHIPPING_THRESHOLD')
  }).tags(['AC-WP12-01', 'wp12'])

  test('type 1 hashes ignore the declared name, whitespace and comments; type 2 renames identifiers by first occurrence and keeps literal values', async ({
    assert,
  }) => {
    const s = await fixtureSymbols()
    const a = normalise(s.get('totalA')!)
    const b = normalise(s.get('totalB')!)
    const renamed = normalise(s.get('grandTotal')!)
    assert.equal(a.type1, b.type1, 'exact twins share a type 1 hash')
    assert.notEqual(a.type1, renamed.type1)
    assert.equal(a.type2, renamed.type2, 'consistent renaming yields the same type 2 hash')
    const refundA = normalise(s.get('refundA')!)
    const refundB = normalise(s.get('refundB')!)
    assert.notEqual(refundA.type2, refundB.type2, "'paid' and 'captured' are kept as values")
    assert.include(renamed.normalised, 'id0')
    assert.notInclude(renamed.normalised, 'grandTotal')
    assert.isAbove(a.tokens.length, 30)
  }).tags(['AC-WP12-01', 'wp12'])

  test('MinHash signatures are deterministic and near misses share an LSH band', async ({
    assert,
  }) => {
    const s = await fixtureSymbols()
    const refundA = normalise(s.get('refundA')!)
    const refundB = normalise(s.get('refundB')!)
    assert.deepEqual(minHash(refundA.normalised), minHash(refundA.normalised))
    const bandsB = lshBands(minHash(refundB.normalised))
    const shared = lshBands(minHash(refundA.normalised)).filter((band) => bandsB.includes(band))
    assert.isNotEmpty(shared)
    const unrelated = lshBands(minHash(normalise(s.get('totalA')!).normalised))
    assert.isEmpty(lshBands(minHash(refundA.normalised)).filter((band) => unrelated.includes(band)))
  }).tags(['AC-WP12-01', 'wp12'])

  test('alignment scores similarity and maps the differing tokens back to line spans', async ({
    assert,
  }) => {
    const s = await fixtureSymbols()
    const refundA = normalise(s.get('refundA')!)
    const refundB = normalise(s.get('refundB')!)
    const aligned = alignTokens(refundA, refundB)
    assert.isAbove(aligned.similarity, 0.85)
    assert.isBelow(aligned.similarity, 1)
    // The seeded difference is the status literal on the first statement line of each function.
    assert.deepEqual(aligned.divergence.left, [{ start: 12, end: 12 }])
    assert.deepEqual(aligned.divergence.right, [{ start: 2, end: 2 }])
    assert.equal(alignTokens(refundA, refundA).similarity, 1)
    assert.deepEqual(alignTokens(refundA, refundA).divergence, { left: [], right: [] })
  }).tags(['AC-WP12-02', 'wp12'])
})
