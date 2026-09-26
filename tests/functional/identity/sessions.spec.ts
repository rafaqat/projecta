import { test } from '@japa/runner'
import type { MockOidcProvider } from '../../../services/mock-oidc/src/provider.js'
import { cookieHeader, profile, signIn, startMockProvider } from '#tests/helpers/oidc'
import { clock } from '#app/auth/session_policy'
import { resetDatabase } from '#tests/helpers/db'

let provider: MockOidcProvider

function sessionIdOf(cookies: string): string | undefined {
  return /adonis-session=([^;]+)/.exec(cookies)?.[1]
}

test.group('session lifecycle (SEC-37)', (group) => {
  group.setup(async () => {
    provider = await startMockProvider()
  })
  group.each.setup(() => resetDatabase())

  test('the session ID changes at sign-in', async ({ client, assert }) => {
    provider.signInAs(profile())
    const before = await client.get('/auth/login').redirects(0)
    const anonymousId = sessionIdOf(cookieHeader(before))
    const { cookies } = await signIn(client, provider, profile())
    const signedInId = sessionIdOf(cookies)
    assert.exists(anonymousId)
    assert.exists(signedInId)
    assert.notEqual(signedInId, anonymousId)
  }).tags(['AC-WP02-02', 'wp02'])

  test('a session idle for 30 minutes is rejected', async ({ client }) => {
    const { cookies } = await signIn(client, provider, profile())
    const signedInAt = Date.now()
    try {
      clock.now = () => signedInAt + 29 * 60_000
      const fresh = await client.get('/api/me').accept('json').header('cookie', cookies)
      fresh.assertStatus(200)
      clock.now = () => signedInAt + 29 * 60_000 + 31 * 60_000
      const idle = await client.get('/api/me').accept('json').header('cookie', cookies)
      idle.assertStatus(401)
    } finally {
      clock.now = () => Date.now()
    }
  }).tags(['AC-WP02-02', 'wp02'])

  test('a session older than 12 hours is rejected even when active', async ({ client }) => {
    const { cookies } = await signIn(client, provider, profile())
    const signedInAt = Date.now()
    try {
      for (let minutes = 20; minutes < 12 * 60; minutes += 20) {
        clock.now = () => signedInAt + minutes * 60_000
        const active = await client.get('/api/me').accept('json').header('cookie', cookies)
        active.assertStatus(200)
      }
      clock.now = () => signedInAt + 12 * 60 * 60_000 + 1000
      const old = await client.get('/api/me').accept('json').header('cookie', cookies)
      old.assertStatus(401)
    } finally {
      clock.now = () => Date.now()
    }
  }).tags(['AC-WP02-02', 'wp02'])

  test('a cookie reused after sign-out receives 401', async ({ client }) => {
    const { cookies } = await signIn(client, provider, profile())
    const me = await client.get('/api/me').accept('json').header('cookie', cookies)
    me.assertStatus(200)
    const csrf = await client.get('/').header('cookie', cookies)
    const xsrf = /XSRF-TOKEN=([^;]+)/.exec(cookieHeader(csrf))?.[1] ?? ''
    const out = await client
      .post('/auth/logout')
      .header('cookie', `${cookies}; XSRF-TOKEN=${xsrf}`)
      .header('x-xsrf-token', decodeURIComponent(xsrf))
      .redirects(0)
    out.assertStatus(302)
    const replay = await client.get('/api/me').accept('json').header('cookie', cookies)
    replay.assertStatus(401)
  }).tags(['AC-WP02-02', 'wp02'])

  test('password login routes do not exist when APP_ENV is not local', async ({
    client,
    assert,
  }) => {
    for (const path of ['/login', '/signup']) {
      const response = await client.get(path)
      response.assertStatus(404)
    }
    const post = await client.post('/login').form({ email: 'a@b.c', password: 'x' })
    assert.equal(post.status(), 404)
  }).tags(['AC-WP02-03', 'wp02'])
})
