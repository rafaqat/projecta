import { test } from '@japa/runner'
import type { MockOidcProvider } from '../../../services/mock-oidc/src/provider.js'
import { signIn, startMockProvider } from '#tests/helpers/oidc'
import { resetDatabase } from '#tests/helpers/db'
import { seedTwoWorkspaces, type SeededUser } from '#tests/helpers/tenancy'
import { inScope } from '#app/security/scope'
import { profile } from '#tests/helpers/oidc'

let provider: MockOidcProvider

const asProfile = (u: SeededUser) => ({ oid: u.oid, tid: u.tid, email: u.email, name: u.email })

/** The Inertia page object embedded in a server-rendered response (SSR is off in tests). */
function inertiaPage(html: string): { component: string; props: Record<string, unknown> } {
  const match = html.match(/<script data-page="[^"]+" type="application\/json">(.*?)<\/script>/s)
  if (!match) throw new Error('no inertia page payload in response')
  return JSON.parse(match[1])
}

test.group('Landing after sign-in', (group) => {
  group.setup(async () => {
    provider = await startMockProvider()
  })
  group.each.setup(() => resetDatabase())

  test('a member who can see exactly one repository in one workspace lands on that repository', async ({
    client,
  }) => {
    const { a } = await seedTwoWorkspaces()
    const { response } = await signIn(client, provider, asProfile(a.member))
    response.assertStatus(302)
    response.assertHeader('location', `/w/${a.workspace.handle}/r/${a.open.handle}`)
  }).tags(['wp02'])

  test('an owner who can see two repositories in one workspace lands on that workspace', async ({
    client,
  }) => {
    const { a } = await seedTwoWorkspaces()
    const { response } = await signIn(client, provider, asProfile(a.owner))
    response.assertStatus(302)
    response.assertHeader('location', `/w/${a.workspace.handle}`)
  }).tags(['wp02'])

  test('a member of two workspaces lands on the workspace list', async ({ client }) => {
    const { a, b } = await seedTwoWorkspaces()
    await inScope({ userId: b.owner.id, workspaceId: b.workspace.id }, (trx) =>
      trx.table('workspace_memberships').insert({
        workspace_id: b.workspace.id,
        user_id: a.member.id,
        role: 'member',
        created_at: new Date(),
      })
    )
    const { response } = await signIn(client, provider, asProfile(a.member))
    response.assertStatus(302)
    response.assertHeader('location', '/workspaces')
  }).tags(['wp02'])

  test('a user with no workspace lands on the workspace list', async ({ client }) => {
    const { response } = await signIn(client, provider, profile())
    response.assertStatus(302)
    response.assertHeader('location', '/workspaces')
  }).tags(['wp02'])

  test('a signed-in user visiting / is forwarded to their landing page', async ({ client }) => {
    const { a } = await seedTwoWorkspaces()
    const { cookies } = await signIn(client, provider, asProfile(a.member))
    const home = await client.get('/').header('cookie', cookies).redirects(0)
    home.assertStatus(302)
    home.assertHeader('location', `/w/${a.workspace.handle}/r/${a.open.handle}`)
  }).tags(['wp02'])

  test('a signed-out visitor to / sees the sign-in page, not the starter page', async ({
    client,
  }) => {
    const home = await client.get('/').redirects(0)
    home.assertStatus(200)
    const page = inertiaPage(home.text())
    if (page.component !== 'home') throw new Error(`rendered ${page.component}`)
    if (page.props.user) throw new Error('signed-out visitor has a user prop')
  }).tags(['wp02'])
})
