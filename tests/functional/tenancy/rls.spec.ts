import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { inScope } from '#app/security/scope'
import { seedTwoWorkspaces } from '#tests/helpers/tenancy'
import { resetDatabase } from '#tests/helpers/db'

test.group('row-level security (INV-07, INV-09)', (group) => {
  group.each.setup(() => resetDatabase())

  test('a transaction that does not set app.workspace_id aborts on a tenant table', async ({
    assert,
  }) => {
    await seedTwoWorkspaces()
    await assert.rejects(
      () => db.transaction((trx) => trx.from('repositories').select('id')),
      /app\.user_id is not set|app\.workspace_id is not set/
    )
    await assert.rejects(
      () => db.from('repositories').select('id'),
      /app\.user_id is not set|app\.workspace_id is not set/
    )
  }).tags(['AC-WP02-07', 'wp02'])

  test('inside a scoped transaction the actor sees only their workspace', async ({ assert }) => {
    const seed = await seedTwoWorkspaces()
    const rows = await inScope(
      { userId: seed.a.owner.id, workspaceId: seed.a.workspace.id },
      (trx) => trx.from('repositories').select('handle').orderBy('handle')
    )
    assert.deepEqual(
      rows.map((r) => r.handle).sort(),
      [seed.a.open.handle, seed.a.restricted.handle].sort()
    )
  }).tags(['AC-WP02-07', 'wp02'])
})

test.group('ablation no_app_scope_checks: RLS alone (AC-WP02-06)', (group) => {
  group.each.setup(() => resetDatabase())
  group.each.setup(() => {
    process.env.ABLATION_NO_APP_SCOPE_CHECKS = '1'
    return () => {
      delete process.env.ABLATION_NO_APP_SCOPE_CHECKS
    }
  })

  test('with application scope checks ablated, every tenant table still refuses cross-workspace reads', async ({
    assert,
  }) => {
    const { WorkspaceAccess } = await import('#app/security/workspace_access')
    const { isAblated } = await import('#app/security/ablation_switch')
    assert.isTrue(
      await isAblated('no_app_scope_checks'),
      'the ablation is active in the test build'
    )

    const seed = await seedTwoWorkspaces()
    const attacker = { userId: seed.a.owner.id }
    const foreign = seed.b.workspace.id

    const readers: Array<[string, () => Promise<unknown[]>]> = [
      ['workspaces', () => WorkspaceAccess.workspaces(attacker, foreign)],
      ['workspace_memberships', () => WorkspaceAccess.memberships(attacker, foreign)],
      ['repositories', () => WorkspaceAccess.repositories(attacker, foreign)],
      ['repository_members', () => WorkspaceAccess.repositoryMembers(attacker, foreign)],
    ]
    for (const [table, read] of readers) {
      const rows = await read().catch((error: Error) => {
        assert.match(error.message, /does not belong to the acting user|not set/, table)
        return []
      })
      assert.deepEqual(rows, [], `${table} leaked rows across workspaces`)
    }
  }).tags(['AC-WP02-06', 'wp02'])

  test('control: the same reads succeed for a member of the workspace', async ({ assert }) => {
    const { WorkspaceAccess } = await import('#app/security/workspace_access')
    const seed = await seedTwoWorkspaces()
    const member = { userId: seed.a.member.id }
    const repos = await WorkspaceAccess.repositories(member, seed.a.workspace.id)
    assert.deepEqual(
      repos.map((r) => r.handle),
      [seed.a.open.handle],
      'member sees the open repository only'
    )
    const owner = { userId: seed.a.owner.id }
    assert.lengthOf(await WorkspaceAccess.repositories(owner, seed.a.workspace.id), 2)
  }).tags(['AC-WP02-06', 'wp02'])
})
