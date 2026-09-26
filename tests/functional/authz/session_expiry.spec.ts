import { test } from '@japa/runner'
import { startMockProvider } from '#tests/helpers/oidc'
import { seedTwoWorkspaces } from '#tests/helpers/tenancy'
import { resetDatabase } from '#tests/helpers/db'

/**
 * An expired or absent session on an `/api/` route is answered 401, never a 302 to a browser page
 * (UAT 2026-09-17): the SPA's `fetch` follows a redirect and reads the HTML login page as its
 * response, leaving the UI half-working until a reload. A browser page navigation still redirects.
 */
test.group('unauthenticated requests: 401 for /api, redirect for pages (SEC-37)', (group) => {
  let handles: { workspace: string; repository: string }

  group.setup(async () => {
    await startMockProvider()
    await resetDatabase()
    const seed = await seedTwoWorkspaces()
    handles = { workspace: seed.a.workspace.handle, repository: seed.a.open.handle }
  })

  test('an unauthenticated POST to the turns stream is refused in a way the client detects as expiry, never a followed 2xx', async ({
    client,
    assert,
  }) => {
    // Without a session, shield's CSRF check refuses the POST before auth (redirect); with a
    // valid token but no session, auth answers 401. Either is `sessionExpired` on the client
    // (status 401 or a redirect `fetch` would follow), which triggers re-authentication rather
    // than reading an HTML page as an SSE stream.
    const r = await client
      .post(`/api/w/${handles.workspace}/r/${handles.repository}/turns`)
      .accept('text/event-stream')
      .header('content-type', 'application/json')
      .json({ question: 'What does this do?' })
      .redirects(0)
    assert.isTrue(
      r.status() === 401 || (r.status() >= 300 && r.status() < 400),
      `expected 401 or a redirect, got ${r.status()}`
    )
  }).tags(['AC-WP02-07', 'wp02'])

  test('an unauthenticated GET to history and scope is 401', async ({ client, assert }) => {
    for (const path of ['history', 'scope']) {
      const r = await client
        .get(`/api/w/${handles.workspace}/r/${handles.repository}/${path}`)
        .accept('json')
        .redirects(0)
      assert.equal(r.status(), 401, path)
    }
  }).tags(['AC-WP02-07', 'wp02'])

  test('an unauthenticated browser navigation to a page still redirects to sign-in', async ({
    client,
    assert,
  }) => {
    const r = await client.get(`/w/${handles.workspace}/r/${handles.repository}`).redirects(0)
    assert.isTrue(r.status() >= 300 && r.status() < 400, `expected a redirect, got ${r.status()}`)
    assert.include(String(r.headers().location ?? ''), '/auth/login')
  }).tags(['AC-WP02-07', 'wp02'])
})
