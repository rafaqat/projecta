import { test } from '@japa/runner'
import { hstsEnabledFor } from '#app/security/headers'

test.group('HTTP security header baseline (SEC-34)', () => {
  test('HTML responses carry the nonce CSP and the header baseline', async ({ client, assert }) => {
    const response = await client.get('/')
    response.assertStatus(200)
    const csp = response.header('content-security-policy') as string
    assert.exists(csp)
    assert.match(csp, /script-src [^;]*'nonce-[A-Za-z0-9+/=_-]+'/)
    assert.notInclude(csp, 'unsafe-inline')
    assert.include(csp, "frame-ancestors 'none'")
    assert.include(csp, "object-src 'none'")
    assert.include(csp, "base-uri 'none'")
    assert.equal(response.header('x-content-type-options'), 'nosniff')
    assert.exists(response.header('referrer-policy'))
    assert.exists(response.header('permissions-policy'))
    assert.notExists(
      response.header('strict-transport-security'),
      'HSTS is off in the test environment'
    )
  }).tags(['AC-WP01-04', 'wp01'])

  test('a 404 for an unmatched path carries the same CSP as a routed page', async ({
    client,
    assert,
  }) => {
    const response = await client.get('/no-such-path').header('accept', 'text/html')
    response.assertStatus(404)
    const csp = response.header('content-security-policy') as string
    assert.exists(csp, 'CSP on the not-found page')
    assert.match(csp, /script-src [^;]*'nonce-[A-Za-z0-9+/=_-]+'/)
    assert.notInclude(csp, 'unsafe-inline')
    assert.include(csp, "frame-ancestors 'none'")
    // The nonce in the header is the nonce the page's scripts carry.
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1]
    assert.include(response.text(), `nonce="${nonce}"`)
  }).tags(['AC-WP01-04', 'wp01'])

  test('every response isolates the origin: COOP and CORP same-origin, on pages and assets', async ({
    client,
    assert,
  }) => {
    for (const path of ['/', '/no-such-path', '/favicon.ico']) {
      const response = await client.get(path)
      assert.equal(response.header('cross-origin-opener-policy'), 'same-origin', path)
      assert.equal(response.header('cross-origin-resource-policy'), 'same-origin', path)
    }
  }).tags(['AC-WP01-04', 'wp01'])

  test('two requests receive different nonces', async ({ client, assert }) => {
    const nonceOf = async () => {
      const response = await client.get('/')
      return /'nonce-([^']+)'/.exec(response.header('content-security-policy') as string)?.[1]
    }
    const first = await nonceOf()
    const second = await nonceOf()
    assert.exists(first)
    assert.notEqual(first, second)
  }).tags(['AC-WP01-04', 'wp01'])

  test('HSTS is enabled only for uat and production', ({ assert }) => {
    assert.isTrue(hstsEnabledFor('uat'))
    assert.isTrue(hstsEnabledFor('production'))
    assert.isFalse(hstsEnabledFor('local'))
    assert.isFalse(hstsEnabledFor('test'))
  }).tags(['AC-WP01-04', 'wp01'])
})
