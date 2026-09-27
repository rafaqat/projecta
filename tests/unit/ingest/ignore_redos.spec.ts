import { test } from '@japa/runner'
import { ignoredBy } from '#app/ingest/ignore'

/**
 * Ignore globs are compiled under RE2 (not native RegExp) because both the pattern (a workspace's
 * custom ignore list) and the path (repo file names) are attacker-controlled, and a glob expands
 * `**`->`.*`. A native regex like `.*a.*a...b` backtracks catastrophically; a 61-char pattern vs a
 * 40-char path measured ~83s of synchronous matching, wedging the shared ingest worker's event loop
 * (a cross-tenant DoS). RE2 matches in guaranteed linear time, so the same input returns immediately.
 */
test.group('ingest/ignore · ReDoS resistance', () => {
  test('a catastrophic-backtracking glob against a long path returns fast (linear time)', ({
    assert,
  }) => {
    const pattern = '**a'.repeat(20) + 'b' // 61 chars; under a native RegExp this pathologically backtracks
    const path = 'a'.repeat(40)
    const start = Date.now()
    const result = ignoredBy(path, [pattern])
    const elapsed = Date.now() - start
    assert.isNull(result, 'the path is not ignored by this pattern')
    assert.isBelow(elapsed, 1000, 'RE2 matches in linear time, not catastrophic backtracking')
  }).tags(['ingest', 'ignore', 'security'])

  test('ordinary globs still match correctly under RE2', ({ assert }) => {
    assert.equal(ignoredBy('node_modules/react/index.js', ['node_modules/']), 'node_modules/')
    assert.equal(ignoredBy('src/app.ts', ['**/*.ts']), '**/*.ts')
    assert.equal(ignoredBy('src/app.ts', ['*.md']), null)
    assert.equal(ignoredBy('dist/bundle.js', ['/dist/']), '/dist/')
  }).tags(['ingest', 'ignore', 'security'])
})
