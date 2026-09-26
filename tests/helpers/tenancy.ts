import { randomUUID } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import { inScope } from '#app/security/scope'
import { newHandle } from '#app/security/handles'

export interface SeededUser {
  id: number
  email: string
  tid: string
  oid: string
}

export interface SeededWorkspace {
  workspace: { id: string; handle: string }
  owner: SeededUser
  member: SeededUser
  outsider: SeededUser
  open: { id: string; handle: string }
  restricted: { id: string; handle: string }
}

async function createUser(label: string): Promise<SeededUser> {
  const tid = 'tenant-local'
  const oid = `oid-${label}-${newHandle()}`
  const email = `${label}-${newHandle()}@example.test`
  const [row] = await db
    .table('users')
    .insert({ email, full_name: label, tid, oid, created_at: new Date(), updated_at: new Date() })
    .returning('id')
  return { id: Number(row.id), email, tid, oid }
}

/**
 * Two real workspaces (testing rule). In each: an owner, a member,
 * an open repository and a restricted repository whose only member is the
 * owner. `outsider` belongs to the other workspace.
 */
async function createWorkspace(label: string): Promise<Omit<SeededWorkspace, 'outsider'>> {
  const owner = await createUser(`${label}-owner`)
  const member = await createUser(`${label}-member`)
  // RETURNING is checked against the read policy, so the id is generated here
  // and the owner membership inserted before anything reads the workspace.
  const workspace = { id: randomUUID(), handle: newHandle() }
  await inScope({ userId: owner.id }, async (trx) => {
    await trx
      .table('workspaces')
      .insert({ ...workspace, name: `Workspace ${label}`, created_at: new Date() })
    await trx.table('workspace_memberships').insert({
      workspace_id: workspace.id,
      user_id: owner.id,
      role: 'owner',
      created_at: new Date(),
    })
  })
  const repos = await inScope({ userId: owner.id, workspaceId: workspace.id }, async (trx) => {
    await trx.table('workspace_memberships').insert({
      workspace_id: workspace.id,
      user_id: member.id,
      role: 'member',
      created_at: new Date(),
    })
    const open = { id: randomUUID(), handle: newHandle() }
    const restricted = { id: randomUUID(), handle: newHandle() }
    await trx.table('repositories').insert({
      ...open,
      workspace_id: workspace.id,
      name: `${label}-open`,
      url: 'https://github.com/example/open',
      visibility: 'workspace',
      created_at: new Date(),
    })
    await trx.table('repositories').insert({
      ...restricted,
      workspace_id: workspace.id,
      name: `${label}-restricted`,
      url: 'https://github.com/example/restricted',
      visibility: 'restricted',
      created_at: new Date(),
    })
    await trx.table('repository_members').insert({
      workspace_id: workspace.id,
      repository_id: restricted.id,
      user_id: owner.id,
      created_at: new Date(),
    })
    return { open, restricted }
  })
  return { workspace, owner, member, ...repos }
}

export async function seedTwoWorkspaces(): Promise<{ a: SeededWorkspace; b: SeededWorkspace }> {
  const a = await createWorkspace('a')
  const b = await createWorkspace('b')
  return { a: { ...a, outsider: b.owner }, b: { ...b, outsider: a.owner } }
}
