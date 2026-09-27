import { test } from '@japa/runner'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TurnEvidence } from '#app/assistant/evidence'
import { exclusionsFor } from '#app/retrieval/exclusions'
import { inScope } from '#app/security/scope'
import { startFixtureGitServer } from '#tests/helpers/git_fixtures'
import { LOOKALIKES_FIXTURE, lookalikeEntries } from '#tests/helpers/lookalikes_fixture'
import { indexFixture, scopeOf, type IndexedFixture } from '#tests/helpers/shop_fixture'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'
import { resetDatabase } from '#tests/helpers/db'

/**
 * Bytes survive from file to hash to citation (WP-19, BL-02/BL-03). The
 * oracle is the fixture file itself, decoded once here, never the stored
 * content: a citation's snippet must be the file's own lines, and its span
 * hash the SHA-256 of those lines.
 */
interface EncodingCase {
  id: string
  file: string
  class: string
}

let a: SeededWorkspace
let fixture: IndexedFixture

/** The fixture file as text, the way a reader sees it: UTF-16 is decoded by its BOM, everything else is UTF-8. */
async function fileText(path: string): Promise<string> {
  const bytes = await readFile(join(LOOKALIKES_FIXTURE, path))
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  return bytes.toString('utf8')
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

test.group('lookalikes · encoding set (WP-19)', (group) => {
  group.setup(async () => {
    await startFixtureGitServer()
    await resetDatabase()
    ;({ a } = await seedTwoWorkspaces())
    fixture = await indexFixture(a, 'lookalikes-encoding', await lookalikeEntries(), 'lookalikes')
  })

  test('every indexed file of the encoding set cites as its own bytes: snippet equals the file lines, span hash equals their SHA-256', async ({
    assert,
  }) => {
    const { cases } = JSON.parse(await readFile('evals/cases/benign/encoding.json', 'utf8')) as {
      cases: EncodingCase[]
    }
    const files = [...new Set(cases.map((c) => c.file))]
    const report: Array<{ file: string; chunks: number }> = []
    for (const file of files) {
      const chunks = await inScope(scopeOf(a), (trx) =>
        trx
          .from('chunks')
          .where({ commit_id: fixture.commitId, path: file })
          .select('id', 'start_line', 'end_line')
      )
      report.push({ file, chunks: chunks.length })
      if (chunks.length === 0) continue
      const text = await fileText(file)
      const expectedLines = text.split('\n')
      const evidence = new TurnEvidence(scopeOf(a), fixture.commitSha)
      const blocks = await evidence.addChunks(chunks.map((c) => c.id))
      for (const block of blocks) {
        const cited = evidence.hydrateMarker(block.source)
        assert.exists(cited, `${file}: the whole span hydrates`)
        const expected = expectedLines.slice(cited!.span.start - 1, cited!.span.end).join('\n')
        assert.equal(cited!.snippet, expected, `${file} L${cited!.span.start}–${cited!.span.end}`)
        assert.equal(
          cited!.spanSha256,
          sha256(expected),
          `${file}: span hash over the file's bytes`
        )
      }
    }
    // A file that is not indexed is an exclusion with a stated reason, never silent (BL-23);
    // whether the exclusion is the right call is the owner's label (expectIngested, expectChunked).
    const exclusions = await exclusionsFor(scopeOf(a), fixture.commitId)
    for (const r of report.filter((x) => x.chunks === 0)) {
      const named = exclusions.find((e) => e.path === r.file)
      assert.exists(named, `${r.file}: excluded with a reason`)
      assert.isString(named?.reason)
    }
    assert.isAtLeast(report.filter((r) => r.chunks > 0).length, 6, 'the set is mostly indexed')
  })
    .tags(['AC-WP19-02', 'wp19'])
    // ON HOLD (2026-09-26): evals/cases/benign/encoding.json is a golden case file whose owner labels
    // (expectIngested / expectChunked per file) a person must author (R-08). It is scaffolded with
    // labelled_by: null; un-skip this test once a person completes the labels.
    .skip(
      true,
      'on hold: evals/cases/benign/encoding.json needs human-authored golden labels (R-08)'
    )
})
