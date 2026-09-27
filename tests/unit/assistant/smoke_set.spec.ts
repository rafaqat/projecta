import { test } from '@japa/runner'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSmokeSet } from '#app/assistant/smoke'

/**
 * The smoke set's questions are human-written and `labelled_by` records who wrote them. An
 * unfinished set must not load: the conformance suite loops over the questions, so an empty set
 * would pass every assertion while proving nothing (AC-WP17-01 would be green with no turn run).
 */
async function setFile(contents: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'smoke-set-'))
  const path = join(dir, 'set.json')
  await writeFile(path, JSON.stringify(contents), 'utf8')
  return path
}

test.group('smoke set', () => {
  test('a set nobody has written questions for is refused, not loaded empty', async ({
    assert,
  }) => {
    const path = await setFile({
      fixture: 'fixtures/shop',
      commit: '',
      labelled_by: null,
      questions: [],
    })

    await assert.rejects(() => loadSmokeSet(path), /labelled_by|questions/)
  }).tags(['AC-WP17-01', 'wp17'])

  test('a labelled set with questions loads', async ({ assert }) => {
    const path = await setFile({
      fixture: 'fixtures/shop',
      commit: 'a'.repeat(40),
      labelled_by: 'someone@example.test',
      questions: ['What does this application do?'],
    })

    const set = await loadSmokeSet(path)
    assert.lengthOf(set.questions, 1)
    assert.equal(set.labelled_by, 'someone@example.test')
  }).tags(['AC-WP17-01', 'wp17'])
})
