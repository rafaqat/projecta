import { test } from '@japa/runner'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import db from '@adonisjs/lucid/services/db'
import type { ApiClient } from '@japa/api-client'
import type { MockOidcProvider } from '../../../services/mock-oidc/src/provider.js'
import { signIn, startMockProvider } from '#tests/helpers/oidc'
import { seedTwoWorkspaces, type SeededUser, type SeededWorkspace } from '#tests/helpers/tenancy'
import { resetDatabase } from '#tests/helpers/db'

let provider: MockOidcProvider
const SNAPSHOT_DIR = 'tests/snapshots/props'

async function sessionFor(client: ApiClient, user: SeededUser, name: string): Promise<string> {
  const { cookies } = await signIn(client, provider, {
    oid: user.oid,
    tid: user.tid,
    email: user.email,
    name,
  })
  return cookies
}

/** The page object Inertia embeds in the HTML as a JSON script element. */
function pageOf(html: string): { component: string; props: Record<string, unknown> } {
  const raw =
    /<script data-page="app" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '{}'
  return JSON.parse(raw)
}

/** Replaces per-run values (handles, emails) so snapshots are stable. */
function normalise(value: unknown, seed: SeededWorkspace): unknown {
  const json = JSON.stringify(value)
    .replaceAll(seed.workspace.handle, '<workspace-handle>')
    .replaceAll(seed.open.handle, '<open-handle>')
    .replaceAll(seed.restricted.handle, '<restricted-handle>')
    .replace(/"[^"]+@example\.test"/g, '"<email>"')
    // The asset version is whatever Vite last built on this machine: "dev" without a manifest, a
    // hash with one. A gitignored public/assets manifest failed this test on every laptop that had
    // run a build (2026-09-19 onwards); it is not what the presenter is judged on.
    .replace(/"assetsVersion":"[^"]*"/g, '"assetsVersion":"<assets-version>"')
  return JSON.parse(json)
}

async function assertSnapshot(name: string, actual: unknown): Promise<void> {
  const path = `${SNAPSHOT_DIR}/${name}.json`
  const rendered = JSON.stringify(actual, null, 2) + '\n'
  const committed = await readFile(path, 'utf8').catch(() => null)
  if (committed === null && process.env.UPDATE_SNAPSHOTS === '1') {
    await mkdir(SNAPSHOT_DIR, { recursive: true })
    await writeFile(path, rendered)
    return
  }
  if (committed === null)
    throw new Error(`missing snapshot ${path}; run once with UPDATE_SNAPSHOTS=1 and review it`)
  if (committed !== rendered) throw new Error(`snapshot ${path} differs:\n${rendered}`)
}

test.group('page presenters (SEC-21)', (group) => {
  group.setup(async () => {
    provider = await startMockProvider()
  })
  group.each.setup(() => resetDatabase())
  group.each.timeout(60_000)

  test('workspace page props match the committed per-role snapshots', async ({ client }) => {
    const seed = await seedTwoWorkspaces()
    for (const [role, user] of [
      ['owner', seed.a.owner],
      ['member', seed.a.member],
    ] as const) {
      const cookies = await sessionFor(client, user, `A ${role}`)
      const page = await client.get(`/w/${seed.a.workspace.handle}`).header('cookie', cookies)
      page.assertStatus(200)
      const { component, props } = pageOf(page.text())
      await assertSnapshot(`workspaces_show.${role}`, {
        component,
        props: normalise(props, seed.a),
      })
    }
  }).tags(['AC-WP02-08', 'wp02'])

  test('the workspace list and repository page props match their committed snapshots', async ({
    client,
  }) => {
    const seed = await seedTwoWorkspaces()
    const cookies = await sessionFor(client, seed.a.member, 'A member')
    for (const [name, path] of [
      ['workspaces_index.member', '/workspaces'],
      ['repositories_show.member', `/w/${seed.a.workspace.handle}/r/${seed.a.open.handle}`],
    ] as const) {
      const page = await client.get(path).header('cookie', cookies)
      page.assertStatus(200)
      const { component, props } = pageOf(page.text())
      await assertSnapshot(name, { component, props: normalise(props, seed.a) })
    }
  }).tags(['AC-WP16-04', 'wp16'])

  test('a canary column on the user model never appears in rendered HTML or props', async ({
    client,
    assert,
  }) => {
    const seed = await seedTwoWorkspaces()
    const canary = `CANARY-COLUMN-${Date.now()}`
    await db.rawQuery('ALTER TABLE users ADD COLUMN IF NOT EXISTS canary_note text')
    await db.from('users').where('id', seed.a.owner.id).update({ canary_note: canary })
    try {
      const cookies = await sessionFor(client, seed.a.owner, 'Canary Owner')
      for (const path of [
        '/',
        '/workspaces',
        `/w/${seed.a.workspace.handle}`,
        `/w/${seed.a.workspace.handle}/r/${seed.a.open.handle}`,
      ]) {
        const html = await client.get(path).header('cookie', cookies)
        html.assertStatus(200)
        assert.notInclude(html.text(), canary, path)
        assert.notInclude(JSON.stringify(pageOf(html.text())), canary, `${path} props`)
      }
      const me = await client.get('/api/me').accept('json').header('cookie', cookies)
      assert.notInclude(me.text(), canary)
    } finally {
      await db.rawQuery('ALTER TABLE users DROP COLUMN IF EXISTS canary_note')
    }
  }).tags(['AC-WP02-08', 'wp02'])
})
