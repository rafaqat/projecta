import { test } from '@japa/runner'
import { Indexer } from '#app/ingest/indexer'
import type { Embedder } from '#app/parse/embedder'
import type { InjectionDetector } from '#app/parse/injection'
import { searchLexical } from '#app/retrieval/search'
import { lexicalFaultCount } from '#app/retrieval/lexical_fallback'
import { startFixtureGitServer } from '#tests/helpers/git_fixtures'
import { indexFixture, scopeOf } from '#tests/helpers/shop_fixture'
import { resetDatabase, settleBm25Indexes } from '#tests/helpers/db'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'

/**
 * ADR-022: a workspace is ranked against its own corpus, not the cluster's.
 *
 * Row-level security decides which rows a query may return, but a BM25 score is not computed from
 * the returned row alone: inverse document frequency comes from the whole index. With one index
 * shared by every workspace, another workspace's documents change a tenant's own scores and can
 * reorder its own results — an inference channel (ordering carries it, even though SEC-28 keeps
 * scores out of every response) and a noisy-neighbour effect on retrieval quality.
 *
 * No model weights: the embedder and the detector are stubs, because what is under test is the
 * lexical corpus, and this suite runs where no weights are fetched.
 */
const stubEmbedder = async (): Promise<Embedder> => ({
  id: 'stub-embedder',
  dimensions: 768,
  embed: async (texts: string[]) => texts.map(() => new Float32Array(768)),
})

const noFlags: InjectionDetector = { id: 'stub-detector', detect: async () => false }

const indexer = () => new Indexer({ embedder: stubEmbedder, detector: noFlags })

/** A document that matches "refund", plus filler so the two workspaces differ. */
const doc = (term: string, n: number) =>
  `// ${term} ${n}\nexport function handler${n}() {\n  return '${term} ${term} ${term}'\n}\n`

let a: SeededWorkspace
let b: SeededWorkspace

test.group('the lexical corpus is per workspace (ADR-022)', (group) => {
  group.setup(async () => {
    await startFixtureGitServer()
  })
  group.each.setup(async () => {
    await resetDatabase()
    ;({ a, b } = await seedTwoWorkspaces())
  })

  test("another workspace's documents do not change a tenant's own scores or order", async ({
    assert,
  }) => {
    // Workspace A: one document about refunds, one about shipping. Nothing else in its corpus.
    const mine = await indexFixture(
      a,
      'tenancy-corpus-a',
      { 'refund.ts': doc('refund', 1), 'shipping.ts': doc('shipping', 2) },
      'mine',
      indexer()
    )
    await settleBm25Indexes()

    const question = 'refund shipping'
    const rank = async () => {
      const before = lexicalFaultCount()
      const hits = await searchLexical(scopeOf(a), mine.commitId, question, 10)
      // A fault would answer from the tsvector column, whose scores are not comparable with BM25's.
      assert.equal(lexicalFaultCount(), before, 'the BM25 index answered, not the fallback')
      return hits.map((h) => [h.path, Number(h.score.toFixed(6))] as const)
    }

    const beforeNeighbour = await rank()
    assert.isNotEmpty(beforeNeighbour, 'the fixture answers the question')

    // Workspace B floods its own corpus with "refund". A cannot read any of it.
    const theirs = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`refund-${i}.ts`, doc('refund', i)])
    )
    await indexFixture(b, 'tenancy-corpus-b', theirs, 'theirs', indexer())
    await settleBm25Indexes()

    const afterNeighbour = await rank()

    // The property: A's own ranking is a function of A's corpus alone.
    assert.deepEqual(
      afterNeighbour,
      beforeNeighbour,
      "a neighbouring workspace's corpus changed this workspace's own scores or order"
    )
  }).tags(['AC-WP02-04', 'wp02'])
})
