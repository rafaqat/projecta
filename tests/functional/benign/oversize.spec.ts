import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'
import { sessionFor, startMockProvider, type Session } from '#tests/helpers/oidc'
import { freshShop, type IndexedFixture } from '#tests/helpers/shop_fixture'
import type { SeededWorkspace } from '#tests/helpers/tenancy'

/**
 * Oversize input stays a model-call guard, but the refusal offers what the
 * index can search for (WP-19, BL-09; owner decision 2026-09-14): the
 * identifiers and paths in the paste that exist at the commit become
 * suggested questions, deterministically, with no model call.
 */
let a: SeededWorkspace
let fixture: IndexedFixture
let provider: Awaited<ReturnType<typeof startMockProvider>>
let owner: Session

const TRACE = `TypeError: Cannot read properties of undefined (reading 'refunds')
    at PaymentService.refundPayment (src/services/PaymentService.ts:14:31)
    at async Router.post (src/routes/orders.ts:19:5)
    at async requireAuth (src/middleware/auth.ts:8:3)
${'    at async Layer.handle [as handle_request] (node_modules/express/lib/router/layer.js:95:5)\n'.repeat(14)}`

test.group('oversize input offers suggestions (WP-19)', (group) => {
  group.setup(async () => {
    provider = await startMockProvider()
    ;({ a, fixture } = await freshShop('shop-oversize'))
  })

  test('a pasted stack trace over the cap is refused with the repository identifiers it names as suggested questions', async ({
    client,
    assert,
  }) => {
    owner = await sessionFor(client as ApiClient, provider, a.owner)
    assert.isAbove(TRACE.length, 400)
    const response = await client
      .post(`/api/w/${a.workspace.handle}/r/${fixture.repositoryHandle}/turns`)
      .header('cookie', owner.cookies)
      .header('x-xsrf-token', owner.xsrf)
      .json({ question: TRACE })
    response.assertStatus(422)
    const body = response.body() as {
      errors: Array<{ reason: string; suggestedQuestions?: string[] }>
    }
    assert.equal(body.errors[0].reason, 'too_long')
    const suggestions = body.errors[0].suggestedQuestions ?? []
    assert.isTrue(
      suggestions.some((q) => q.includes('refundPayment`')),
      JSON.stringify(suggestions)
    )
    assert.isTrue(suggestions.some((q) => q.includes('`src/routes/orders.ts`')))
    assert.isFalse(
      suggestions.some((q) => q.includes('node_modules')),
      'nothing outside the index'
    )
  }).tags(['AC-WP19-11', 'wp19'])
})
