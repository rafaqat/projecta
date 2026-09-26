import { test } from '@japa/runner'
import type { AnswerEvent } from '#app/assistant/protocol'
import { sourceKey, sourcesOf } from '#app/assistant/answer_layout'

const cite = (handle: string, name: string): AnswerEvent =>
  ({
    type: 'citation',
    handle,
    commitSha: 'c',
    blobSha: 'b',
    spanSha256: 's',
    symbol: { path: 'a.js', qualifiedName: name, kind: 'function', span: { start: 1, end: 2 } },
    span: { start: 1, end: 2 },
    snippet: 'x',
    precision: 'span',
    origin: 'repo',
  }) as AnswerEvent

test.group('evidence rail: sources are numbered per turn', () => {
  test('the same handle in two turns is two sources: handles are turn-local (UAT 2026-09-17: chip 1 of the second answer opened the first answer’s source)', ({
    assert,
  }) => {
    const sources = sourcesOf([
      { events: [cite('r1', 'addProducts3Get'), cite('r2', 'viewUsers')] },
      { events: [cite('r1', 'titleEl'), cite('r1', 'titleEl'), cite('r3', 'checkTitle')] },
    ])
    assert.deepEqual(
      [...sources.values()].map((s) => [s.n, s.key, s.citation.symbol.qualifiedName]),
      [
        [1, sourceKey(0, 'r1'), 'addProducts3Get'],
        [2, sourceKey(0, 'r2'), 'viewUsers'],
        [3, sourceKey(1, 'r1'), 'titleEl'],
        [4, sourceKey(1, 'r3'), 'checkTitle'],
      ]
    )
  }).tags(['AC-WP06-05', 'wp06'])
})
