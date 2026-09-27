import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import { InProcessOrchestrator } from '#app/assistant/in_process'
import type { AnswerEvent } from '#app/assistant/protocol'
import { answerTurn } from '#app/assistant/turn_service'
import { Indexer } from '#app/ingest/indexer'
import type { InjectionDetector } from '#app/parse/injection'
import { retrieve, symbolNameHits } from '#app/retrieval/hybrid'
import { searchLexical, searchVector } from '#app/retrieval/search'
import { lexicalFaultCount } from '#app/retrieval/lexical_fallback'
import { defaultEmbedder } from '#app/parse/embedder'
import { scopePolicy } from '#app/retrieval/router'
import { inScope } from '#app/security/scope'
import { ScriptedScopeClassifier } from '#app/retrieval/scope_classifier'
import { ScopeThrottle } from '#app/retrieval/throttle'
import { startFixtureGitServer } from '#tests/helpers/git_fixtures'
import {
  indexFixture,
  scopeOf,
  shopEntries,
  type IndexedFixture,
} from '#tests/helpers/shop_fixture'
import { ScriptedModel, type ScriptTurn } from '#tests/helpers/scripted_model'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'
import { worthClassifying } from '#app/parse/prose'
import { resetDatabase, settleBm25Indexes } from '#tests/helpers/db'

/**
 * `injection_suspected` is a signal, never a gate (WP-19, BL-14):
 * with the flag forced on every chunk, retrieval results, their order and the
 * gate's outcome are identical to the unflagged index. A false positive from
 * the detector can therefore never become a recall loss.
 *
 * The flag is forced by a detector at index time, in a second copy of the
 * fixture, never by rewriting rows: an UPDATE inserts fresh entries into the
 * BM25 index and its corpus statistics never return to their earlier state
 * (not after VACUUM either), so near-tied scores flip and the comparison
 * would measure the index's history, not the flag. Two commits indexed from
 * the same entries, with the memtable spilled and the segments merged once
 * both are in, are scored under the same statistics.
 */
const flagging = (id: string, suspected: boolean): InjectionDetector => ({
  id,
  detect: async () => suspected,
})

/**
 * How many BM25 index faults happened while `work` ran. A comparison between two lexical runs is
 * only meaningful if both of them ran BM25: the index can fault (upstream
 * timescale/pg_textsearch#515, `tp_chain_walker_next` raising `data_corrupted` under concurrent
 * ingest) and `searchLexical` then answers that one call from the tsvector column, so the two sides
 * ranked with different rankers and any difference measures the fault, not the thing under test.
 */
async function faultsDuring<T>(work: () => Promise<T>): Promise<[T, number]> {
  const before = lexicalFaultCount()
  const out = await work()
  return [out, lexicalFaultCount() - before]
}

/** Said on stdout, so a run that could not compare says so instead of passing quietly. */
function notComparable(what: string, faults: number) {
  console.warn(
    `[bm25] ${what}: ${faults} index fault(s) during this comparison; the arms ran different ` +
      `rankers, so equivalence was not asserted (timescale/pg_textsearch#515)`
  )
}

let a: SeededWorkspace
/** The control: nothing flagged. */
let fixture: IndexedFixture
/** The ablation: every chunk flagged by the detector when indexed. */
let flagged: IndexedFixture

const QUESTIONS = [
  'How is a payment refunded?',
  'Who calls `refundPayment`?',
  'How does `requireAuth` protect routes?',
  'inventory stock reservation',
]

const script: ScriptTurn[] = [
  (request) => {
    const blocks = request.messages
      .at(-1)!
      .content.flatMap((b) => (b.type === 'tool_result' ? b.content : [b]))
    const first = blocks.find((b) => b.type === 'search_result') as { source: string }
    return [
      {
        type: 'text',
        delta: 'Refunds go through `refundPayment`. ',
        citations: [{ handle: first.source, startBlock: 0, endBlock: 0, citedText: '' }],
      },
      { type: 'text', delta: 'It also logs the outcome. ' },
      { type: 'end', stopReason: 'end_turn' },
    ]
  },
]

async function turn(indexed: IndexedFixture, question: string): Promise<AnswerEvent[]> {
  const orchestrator = new InProcessOrchestrator({
    model: new ScriptedModel(script),
    classifier: new ScriptedScopeClassifier(() => 'explanation'),
    throttle: new ScopeThrottle(10, 600_000),
  })
  const events: AnswerEvent[] = []
  for await (const e of answerTurn(
    {
      scope: scopeOf(a),
      repository: { id: indexed.repositoryId, name: 'shop', activeCommitId: indexed.commitId },
      question,
      requestId: randomUUID(),
    },
    new AbortController().signal,
    { orchestrator }
  ))
    events.push(e)
  return events
}

/** Everything the reader would see, minus handles and ids that differ per turn by construction. */
const observable = (events: AnswerEvent[]) =>
  events
    .filter((e) => e.type !== 'status' || !e.label.startsWith('retrieval:'))
    .map((e) => {
      if (e.type === 'citation')
        return { type: e.type, path: e.symbol.path, span: e.span, snippet: e.snippet }
      if (e.type === 'status') return { type: e.type, label: e.label, runState: e.runState }
      if (e.type === 'verification') return { type: e.type, status: e.status }
      return e
    })

test.group('injection flag ablation (WP-19, BL-14)', (group) => {
  group.setup(async () => {
    await startFixtureGitServer()
    await resetDatabase()
    ;({ a } = await seedTwoWorkspaces())
    const entries = await shopEntries()
    fixture = await indexFixture(
      a,
      'shop-flag-ablation',
      entries,
      'shop',
      new Indexer({ detector: flagging('none', false) })
    )
    flagged = await indexFixture(
      a,
      'shop-flag-ablation-flagged',
      entries,
      'shop-flagged',
      new Indexer({ detector: flagging('all', true) })
    )
    // Both arms under one segment layout: scores follow the segment a row lives in.
    await settleBm25Indexes()
  })

  const flaggedCount = (commitId: string) =>
    inScope(scopeOf(a), (trx) =>
      trx
        .from('chunks')
        .where({ commit_id: commitId, injection_suspected: true })
        .count('* as n')
        .first()
    ).then((row) => Number(row?.n))

  test('both arms hold the same chunks: the comparison measures the flag, not a parse that timed out', async ({
    assert,
  }) => {
    // CI 34942428375: the flagged arm's top-k held files the control's never did, which no
    // scoring difference explains; a file skipped in one arm (parse timeout under load) is not
    // cached and is parsed again for the other. This names that before the ranking comparison.
    const chunksOf = (commitId: string) =>
      inScope(scopeOf(a), (trx) =>
        trx
          .from('chunks')
          .where('commit_id', commitId)
          .select('path', 'start_line', 'end_line')
          .orderBy(['path', 'start_line', 'end_line'])
      ).then((rows) => rows.map((r) => `${r.path}:${r.start_line}-${r.end_line}`))
    const [control, ablated] = await Promise.all([
      chunksOf(fixture.commitId),
      chunksOf(flagged.commitId),
    ])
    assert.deepEqual(ablated, control, 'the arms were chunked identically')
    assert.deepEqual(flagged.outcome.filesSkipped, fixture.outcome.filesSkipped)
    assert.equal(flagged.outcome.filesParsed, fixture.outcome.filesParsed)
    // CI 34985649254: identical chunk sets, yet the fused ranking differed by whole files. Each
    // retriever is compared on its own, and each arm's vectors are checked present, so a
    // difference names its source instead of the fusion.
    const unembedded = (commitId: string) =>
      inScope(scopeOf(a), (trx) =>
        trx
          .from('chunks')
          .where('commit_id', commitId)
          .whereNull('embedding')
          .count('* as n')
          .first()
      ).then((row) => Number(row?.n))
    assert.equal(await unembedded(fixture.commitId), 0, 'every control chunk has a vector')
    assert.equal(await unembedded(flagged.commitId), 0, 'every ablated chunk has a vector')
    const embedder = await defaultEmbedder()
    const k = scopePolicy().budgets.candidatesPerRetriever
    const shapeOf = (
      hits: Array<{ path: string; startLine: number; endLine: number; score: number }>
    ) => hits.map((h) => [h.path, h.startLine, h.endLine, Number(h.score.toFixed(4))])
    for (const question of QUESTIONS) {
      const [vector] = await embedder.embed([question])
      assert.deepEqual(
        shapeOf(await searchVector(scopeOf(a), flagged.commitId, vector, k)),
        shapeOf(await searchVector(scopeOf(a), fixture.commitId, vector, k)),
        `vector retriever: ${question}`
      )
      assert.deepEqual(
        shapeOf(await searchLexical(scopeOf(a), flagged.commitId, question, k)),
        shapeOf(await searchLexical(scopeOf(a), fixture.commitId, question, k)),
        `lexical retriever: ${question}`
      )
    }
  }).tags(['AC-WP19-07', 'wp19'])

  test('the lexical retriever returns only chunks that match, whichever plan the database picks', async ({
    assert,
  }) => {
    // CI 35011180473: the same question returned 9 chunks in one arm and 45 in the other. The
    // pg_textsearch query ordered every chunk of the commit by score: an index scan yields only
    // documents the index matched, a sequential scan scores the rest at 0 and the limit lets
    // them through, and the plan follows the planner's statistics — different per arm, per run.
    // Zero-score tail hits then earn reciprocal-rank credit in the fusion.
    const k = scopePolicy().budgets.candidatesPerRetriever
    const retrievers = {
      lexical: (q: string) => searchLexical(scopeOf(a), fixture.commitId, q, k),
      symbols: (q: string) => symbolNameHits(scopeOf(a), fixture.commitId, q, k),
    }
    for (const [name, search] of Object.entries(retrievers)) {
      for (const question of QUESTIONS) {
        const [indexed, indexedFaults] = await faultsDuring(() => search(question))
        const [sequential, sequentialFaults] = await faultsDuring(() =>
          inScope(scopeOf(a), async (trx) => {
            await trx.rawQuery('set local enable_indexscan = off')
            await trx.rawQuery('set local enable_bitmapscan = off')
            return search(question)
          })
        )
        // Holds whichever backend answered: a hit is a match, in BM25 or in tsvector.
        assert.isTrue(
          indexed.every((h) => h.score > 0),
          `${name}, ${question}: a hit is a match`
        )
        if (indexedFaults + sequentialFaults > 0) {
          notComparable(`${name}, ${question}`, indexedFaults + sequentialFaults)
          continue
        }
        // The heap scan is the truth about what matches. If it found hits and the index scan found
        // none, the index did not answer at all — a different failure from the two arms disagreeing
        // about the tail, and one the assertion above cannot see, since `every` holds of an empty
        // array. Named here so a run says so instead of printing a set difference against nothing
        // (seen in CI on slice-5: heap 8, index 0, for "How is a payment refunded?").
        if (sequential.length > 0) {
          assert.isNotEmpty(
            indexed,
            `${name}, ${question}: the heap scan matched ${sequential.length} chunks, the index scan none`
          )
        }
        assert.deepEqual(
          sequential.map((h) => [h.path, h.startLine, Number(h.score.toFixed(4))]),
          indexed.map((h) => [h.path, h.startLine, Number(h.score.toFixed(4))]),
          `${name}, ${question}: the same set under either plan`
        )
      }
    }
  }).tags(['AC-WP05-01', 'wp05', 'AC-WP19-07', 'wp19'])

  test('with every chunk flagged, retrieval returns the same chunks in the same order with the same status', async ({
    assert,
  }) => {
    const shape = async (commitId: string, question: string) => {
      const r = await retrieve(scopeOf(a), commitId, question)
      return {
        status: r.status,
        chunks: r.chunks.map((x) => [x.path, x.startLine, x.endLine]),
        excludedPaths: r.excludedPaths,
      }
    }
    const [control, controlFaults] = await faultsDuring(() =>
      Promise.all(QUESTIONS.map((q) => shape(fixture.commitId, q)))
    )
    const [repeat, repeatFaults] = await faultsDuring(() =>
      Promise.all(QUESTIONS.map((q) => shape(fixture.commitId, q)))
    )
    const [flaggedShape, flaggedFaults] = await faultsDuring(() =>
      Promise.all(QUESTIONS.map((q) => shape(flagged.commitId, q)))
    )
    const faults = controlFaults + repeatFaults + flaggedFaults
    if (faults > 0) notComparable('retrieval determinism and the flag ablation', faults)
    else {
      assert.deepEqual(repeat, control, 'retrieval is deterministic')
      assert.deepEqual(flaggedShape, control)
    }
    assert.equal(await flaggedCount(fixture.commitId), 0, 'the control has no flag')
    // The detector reads a chunk's prose only (app/parse/prose.ts): a chunk without
    // comments or strings is clean by construction and never sent, so "every chunk" is every
    // chunk that carries prose. The ablation measures the flag against exactly that set.
    const chunks = await inScope(scopeOf(a), (trx) =>
      trx
        .from('chunks')
        .where('commit_id', flagged.commitId)
        .select('path', 'text', 'injection_suspected')
    )
    // The stored text carries the chunk header (`// path:`, `// symbol:`); the gate sees the code,
    // and reads it by file type, so the oracle passes the path as the indexer does.
    const codeOf = (text: string) =>
      text
        .split('\n')
        .filter((l) => !/^\/\/ (path|symbol): /.test(l))
        .join('\n')
    const withProse = chunks.filter((c) => worthClassifying(codeOf(String(c.text)), String(c.path)))
    assert.isAbove(withProse.length, 0, 'the fixture has chunks with prose')
    assert.isTrue(
      withProse.every((c) => c.injection_suspected === true),
      'every chunk with prose is flagged'
    )
    assert.equal(await flaggedCount(flagged.commitId), withProse.length)
  }).tags(['AC-WP19-07', 'wp19'])

  test('with every chunk flagged, the gate releases the same text, citations and notices', async ({
    assert,
  }) => {
    const control = await turn(fixture, 'How is a payment refunded?')
    const ablated = await turn(flagged, 'How is a payment refunded?')
    assert.deepEqual(observable(ablated), observable(control))
    assert.isTrue(
      control.some((e) => e.type === 'citation'),
      'the control turn cited something'
    )
  }).tags(['AC-WP19-07', 'wp19'])
})
