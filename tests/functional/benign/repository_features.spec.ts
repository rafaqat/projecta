import { test } from '@japa/runner'
import { exclusionsFor } from '#app/retrieval/exclusions'
import { inScope } from '#app/security/scope'
import { startFixtureGitServer } from '#tests/helpers/git_fixtures'
import { lookalikeEntries } from '#tests/helpers/lookalikes_fixture'
import { indexFixture, scopeOf, type IndexedFixture } from '#tests/helpers/shop_fixture'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'
import { resetDatabase } from '#tests/helpers/db'

/**
 * Benign repository features are skipped and named, never indexed as
 * content and never a reason to refuse the repository (WP-19, BL-22; owner
 * decision 2026-09-14). A UTF-16 file is text, decoded by its byte order
 * mark (labelled enc-utf16: expectIngested).
 */
let a: SeededWorkspace
let fixture: IndexedFixture

const chunksOf = (path: string) =>
  inScope(scopeOf(a), (trx) =>
    trx.from('chunks').where({ commit_id: fixture.commitId, path }).select('id')
  )

test.group('lookalikes · symlink, submodule, UTF-16 (WP-19)', (group) => {
  group.setup(async () => {
    await startFixtureGitServer()
    await resetDatabase()
    ;({ a } = await seedTwoWorkspaces())
    fixture = await indexFixture(a, 'lookalikes-features', await lookalikeEntries(), 'lookalikes')
  })

  test('a symlink and a submodule are named exclusions with no chunks; the repository still indexes', async ({
    assert,
  }) => {
    assert.match(fixture.commitSha, /^[0-9a-f]{40}$/)
    assert.lengthOf(await chunksOf('docs/names-link.ts'), 0, 'the link target text is not content')
    const exclusions = await exclusionsFor(scopeOf(a), fixture.commitId)
    assert.deepInclude(exclusions, { path: 'docs/names-link.ts', reason: 'symlink' })
    assert.deepInclude(exclusions, { path: 'vendor/shared', reason: 'submodule' })
  }).tags(['AC-WP19-11', 'wp19'])

  test('a UTF-16 file with a byte order mark is decoded and indexed as text', async ({
    assert,
  }) => {
    assert.isNotEmpty(await chunksOf('src/encoding/utf16le.ts'))
    const exclusions = await exclusionsFor(scopeOf(a), fixture.commitId)
    assert.isFalse(exclusions.some((e) => e.path === 'src/encoding/utf16le.ts'))
  }).tags(['AC-WP19-02', 'wp19'])
})
