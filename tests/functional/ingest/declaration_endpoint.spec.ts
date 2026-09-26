import { test } from '@japa/runner'
import type { MockOidcProvider } from '../../../services/mock-oidc/src/provider.js'
import { sessionFor, startMockProvider } from '#tests/helpers/oidc'
import { startFixtureGitServer } from '#tests/helpers/git_fixtures'
import { resetDatabase } from '#tests/helpers/db'
import { indexFixture, shopEntries } from '#tests/helpers/shop_fixture'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'

/**
 * The declaration endpoint serves the code of a symbol the answer named but did not cite,
 * so the grey box can open it on the right without a model turn. It returns the smallest symbol
 * containing the line, from the active commit's indexed blob, and 404s rather than guess.
 */
let a: SeededWorkspace
let provider: MockOidcProvider

test.group('declaration endpoint', (group) => {
  group.setup(async () => {
    provider = await startMockProvider()
    await startFixtureGitServer()
  })
  group.each.timeout(180_000)
  group.each.setup(async () => {
    await resetDatabase()
    ;({ a } = await seedTwoWorkspaces())
  })

  test("returns an uncited symbol's own code; 404 for an unknown line; requires membership", async ({
    client,
    assert,
  }) => {
    const owner = await sessionFor(client, provider, a.owner)
    const fixture = await indexFixture(a, 'shop-declaration', await shopEntries(), 'shop')
    const base = `/api/w/${a.workspace.handle}/r/${fixture.repositoryHandle}`

    // A method an answer might name without citing.
    const ok = await client
      .get(`${base}/declaration?path=src/services/PaymentService.ts&line=12`)
      .header('cookie', owner.cookies)
    ok.assertStatus(200)
    const body = ok.body() as { qualifiedName: string; start: number; end: number; lines: string[] }
    assert.include(body.qualifiedName, 'refundPayment')
    assert.isTrue(
      body.lines.some((l) => l.includes('refundPayment')),
      'the declaration line is in the returned code'
    )
    assert.equal(body.lines.length, body.end - body.start + 1, 'exactly the symbol span')

    // No symbol at that line: a clean 404, never a fabricated body.
    const missing = await client
      .get(`${base}/declaration?path=src/services/PaymentService.ts&line=99999`)
      .header('cookie', owner.cookies)
    missing.assertStatus(404)

    // Unauthenticated: the repository is not visible, so the read is refused.
    const anon = await client.get(`${base}/declaration?path=src/services/PaymentService.ts&line=12`)
    assert.isAbove(anon.status(), 299)
  }).tags(['wp-ui', 'assistant'])
})
