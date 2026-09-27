import { test } from '@japa/runner'
import router from '@adonisjs/core/services/router'
import type { ApiClient } from '@japa/api-client'
import type { MockOidcProvider } from '../../../services/mock-oidc/src/provider.js'
import { DENIED, generateIdorMatrix, type IdorActor } from '#app/security/idor_matrix'
import type { RouteShape } from '#app/security/route_policies'
import { cookieHeader, signIn, startMockProvider } from '#tests/helpers/oidc'
import { seedTwoWorkspaces, type SeededUser } from '#tests/helpers/tenancy'
import { resetDatabase } from '#tests/helpers/db'

let provider: MockOidcProvider

function liveRoutes(): RouteShape[] {
  return Object.values(router.toJSON())
    .flat()
    .map((route) => ({
      pattern: route.pattern,
      methods: route.methods,
      middlewareNames: Array.from(route.middleware.all(), (m) =>
        typeof m === 'object' && 'name' in m ? String(m.name) : ''
      ),
    }))
}

interface Session {
  cookies: string
  xsrf: string
}

/** A signed-in session plus its CSRF token, so mutating requests reach the authorisation layer. */
async function sessionFor(client: ApiClient, user: SeededUser): Promise<Session> {
  const { cookies } = await signIn(client, provider, {
    oid: user.oid,
    tid: user.tid,
    email: user.email,
    name: 'x',
  })
  const page = await client.get('/').header('cookie', cookies)
  const xsrf = /XSRF-TOKEN=([^;]+)/.exec(cookieHeader(page))?.[1] ?? ''
  return { cookies: `${cookies}; XSRF-TOKEN=${xsrf}`, xsrf: decodeURIComponent(xsrf) }
}

test.group('IDOR matrix (SEC-22, INV-10)', (group) => {
  group.setup(async () => {
    provider = await startMockProvider()
  })
  group.each.setup(() => resetDatabase())
  group.each.timeout(120_000)

  test('every cross-scope access on every resource route is denied with 403 or 404', async ({
    client,
    assert,
  }) => {
    const seed = await seedTwoWorkspaces()
    const actors: Array<IdorActor & { user: SeededUser }> = [
      {
        label: 'a-owner',
        user: seed.a.owner,
        plainMember: false,
        workspace: seed.a.workspace.handle,
        repositories: { open: seed.a.open.handle, restricted: seed.a.restricted.handle },
        otherWorkspace: seed.b.workspace.handle,
        otherRepositories: { open: seed.b.open.handle, restricted: seed.b.restricted.handle },
      },
      {
        label: 'a-member',
        user: seed.a.member,
        plainMember: true,
        workspace: seed.a.workspace.handle,
        repositories: { open: seed.a.open.handle, restricted: seed.a.restricted.handle },
        otherWorkspace: seed.b.workspace.handle,
        otherRepositories: { open: seed.b.open.handle, restricted: seed.b.restricted.handle },
      },
      {
        label: 'b-owner',
        user: seed.b.owner,
        plainMember: false,
        workspace: seed.b.workspace.handle,
        repositories: { open: seed.b.open.handle, restricted: seed.b.restricted.handle },
        otherWorkspace: seed.a.workspace.handle,
        otherRepositories: { open: seed.a.open.handle, restricted: seed.a.restricted.handle },
      },
    ]
    const matrix = generateIdorMatrix(liveRoutes(), actors)
    assert.isAtLeast(
      matrix.length,
      3 * 3 + 3 + 1,
      'the matrix covers every resource route for every actor'
    )

    const sessions = new Map<string, Session>()
    for (const actor of actors) sessions.set(actor.label, await sessionFor(client, actor.user))

    const failures: string[] = []
    for (const c of matrix) {
      const session = sessions.get(c.actor)!
      const response = await client
        .request(c.path, c.method.toLowerCase() as 'get')
        .accept('json')
        .header('cookie', session.cookies)
        .header('x-xsrf-token', session.xsrf)
        .redirects(0)
      if (!DENIED.includes(response.status()))
        failures.push(`${c.actor} ${c.method} ${c.path} (${c.reason}) -> ${response.status()}`)
    }
    assert.deepEqual(failures, [])

    // Positive controls: the same routes succeed inside the actor's scope.
    const owner = sessions.get('a-owner')!
    const own = await client.get(`/w/${seed.a.workspace.handle}`).header('cookie', owner.cookies)
    own.assertStatus(200)
    const restricted = await client
      .get(`/w/${seed.a.workspace.handle}/r/${seed.a.restricted.handle}`)
      .header('cookie', owner.cookies)
    restricted.assertStatus(200)
    const registration = await client
      .post(`/w/${seed.a.workspace.handle}/repos`)
      .accept('json')
      .header('cookie', owner.cookies)
      .header('x-xsrf-token', owner.xsrf)
      .json({ url: 'ftp://not-allowed' })
    registration.assertStatus(422)
    const asMember = sessions.get('a-member')!
    const memberRegistration = await client
      .post(`/w/${seed.a.workspace.handle}/repos`)
      .accept('json')
      .header('cookie', asMember.cookies)
      .header('x-xsrf-token', asMember.xsrf)
      .json({ url: 'https://github.com/acme/shop' })
    memberRegistration.assertStatus(403)
  }).tags(['AC-WP02-05', 'wp02'])

  test('a thrown policy evaluation error results in denial, not access', async ({ client }) => {
    const seed = await seedTwoWorkspaces()
    const { cookies } = await sessionFor(client, seed.a.owner)
    process.env.FAULT_POLICY_EVALUATION = '1'
    try {
      const response = await client
        .get(`/w/${seed.a.workspace.handle}`)
        .accept('json')
        .header('cookie', cookies)
      response.assertStatus(403)
    } finally {
      delete process.env.FAULT_POLICY_EVALUATION
    }
    const recovered = await client
      .get(`/w/${seed.a.workspace.handle}`)
      .accept('json')
      .header('cookie', cookies)
    recovered.assertStatus(200)
  }).tags(['AC-WP02-07', 'wp02'])
})
