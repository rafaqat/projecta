import { test } from '@japa/runner'
import type { MockOidcProvider } from '../../../services/mock-oidc/src/provider.js'
import { profile, startMockProvider } from '#tests/helpers/oidc'
import { resetDatabase } from '#tests/helpers/db'

let provider: MockOidcProvider

/**
 * Sign-in leaves the origin. An Inertia visit fetches over XHR, and a 302 to
 * the provider would be followed as XHR and blocked by connect-src; Inertia's
 * protocol for a full navigation is 409 with X-Inertia-Location.
 */
test.group('sign-in started from an Inertia visit', (group) => {
  group.setup(async () => {
    provider = await startMockProvider()
  })
  group.each.setup(() => resetDatabase())

  test('answers 409 with X-Inertia-Location at the provider, not a 302', async ({
    client,
    assert,
  }) => {
    provider.signInAs(profile())
    // An unknown asset version is itself answered 409 (reload); learn the current one first.
    const probe = await client.get('/').header('x-inertia', 'true').redirects(0)
    const version = String(probe.header('x-inertia-version') ?? '')
    const response = await client
      .get('/auth/login')
      .header('x-inertia', 'true')
      .header('x-inertia-version', version)
      .redirects(0)
    response.assertStatus(409)
    const location = response.header('x-inertia-location')
    assert.isString(location)
    assert.isTrue(
      String(location).startsWith(provider.issuer),
      `${location} is not at the provider ${provider.issuer}`
    )
    assert.include(String(location), 'code_challenge_method=S256')
  }).tags(['AC-WP02-01', 'wp02'])

  test('a plain navigation still redirects with 302', async ({ client }) => {
    provider.signInAs(profile())
    const response = await client.get('/auth/login').redirects(0)
    response.assertStatus(302)
  }).tags(['AC-WP02-01', 'wp02'])
})
