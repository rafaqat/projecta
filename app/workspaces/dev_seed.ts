import { randomUUID } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import { newHandle } from '#app/security/handles'
import { inScope } from '#app/security/scope'

/**
 * The local stack's seed (`make setup` → `node ace dev:seed`): the dev
 * identities the mock provider and the Keycloak realm sign in as, and one
 * "Local" workspace, so the first sign-in lands in a workspace. Sign-in
 * matches on (tid, oid), so a seeded row is the row sign-in reuses. Local
 * only: any other environment provisions through `workspace:create` or,
 * later, the platform (WP-14). Idempotent.
 */
export const DEV_IDENTITIES: ReadonlyArray<{
  provider: string
  tid: string
  oid: string
  email: string
  fullName: string
  role: 'owner' | 'member'
}> = [
  {
    provider: 'mock-oidc',
    tid: 'tenant-local',
    oid: 'local-developer',
    email: 'developer@example.test',
    fullName: 'Local Developer',
    role: 'owner',
  },
  {
    // docker/keycloak/realm.json, ids pinned so a re-import keeps them.
    provider: 'keycloak',
    tid: 'tenant-local',
    oid: '2e0e8851-4e38-47b4-aa85-bef4a4558ea6',
    email: 'developer@example.test',
    fullName: 'Developer',
    role: 'owner',
  },
  {
    provider: 'keycloak',
    tid: 'tenant-local',
    oid: '7c1d5f0a-3b8e-4c2d-9e6f-1a2b3c4d5e6f',
    email: 'reviewer@example.test',
    fullName: 'Reviewer',
    role: 'member',
  },
]

export const LOCAL_WORKSPACE = 'Local'

export interface SeedOutcome {
  users: Array<{ id: number; oid: string; provider: string; role: string }>
  workspace: { id: string; handle: string; name: string; created: boolean }
}

export async function seedLocalWorkspace({ appEnv }: { appEnv: string }): Promise<SeedOutcome> {
  if (appEnv !== 'local')
    throw new Error(`dev:seed runs on the local stack only (APP_ENV is ${appEnv})`)

  const users: SeedOutcome['users'] = []
  for (const identity of DEV_IDENTITIES) {
    const existing = await db
      .from('users')
      .where({ tid: identity.tid, oid: identity.oid })
      .select('id')
      .first()
    let id: number
    if (existing) id = Number(existing.id)
    else {
      const inserted = await db
        .table('users')
        .insert({
          tid: identity.tid,
          oid: identity.oid,
          email: identity.email,
          full_name: identity.fullName,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .returning('id')
      id = Number(inserted[0].id)
    }
    users.push({ id, oid: identity.oid, provider: identity.provider, role: identity.role })
  }

  const owner = users.find((u) => u.role === 'owner')!
  // The workspace the owner already has under this name, or a new one.
  const existing = await inScope({ userId: owner.id }, (trx) =>
    trx
      .from('workspaces')
      .join('workspace_memberships as m', 'm.workspace_id', 'workspaces.id')
      .where({ 'workspaces.name': LOCAL_WORKSPACE, 'm.user_id': owner.id, 'm.role': 'owner' })
      .select('workspaces.id', 'workspaces.handle')
      .first()
  )
  const workspace = existing
    ? { id: String(existing.id), handle: String(existing.handle), created: false }
    : { id: randomUUID(), handle: newHandle(), created: true }
  if (workspace.created)
    await inScope({ userId: owner.id }, (trx) =>
      trx.table('workspaces').insert({
        id: workspace.id,
        handle: workspace.handle,
        name: LOCAL_WORKSPACE,
        created_at: new Date(),
      })
    )
  // Each membership in its own user's scope: a user reads and writes their own row (RLS).
  for (const user of users)
    await inScope({ userId: user.id }, async (trx) => {
      const member = await trx
        .from('workspace_memberships')
        .where({ workspace_id: workspace.id, user_id: user.id })
        .first()
      if (!member)
        await trx.table('workspace_memberships').insert({
          workspace_id: workspace.id,
          user_id: user.id,
          role: user.role,
          created_at: new Date(),
        })
    })
  return { users, workspace: { ...workspace, name: LOCAL_WORKSPACE } }
}
