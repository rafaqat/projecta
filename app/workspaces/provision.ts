import { randomUUID } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import { newHandle } from '#app/security/handles'
import { inScope } from '#app/security/scope'
import { securityEvents } from '#app/security/events/index'

/**
 * Workspace provisioning (operator's action, `node ace workspace:create`).
 * A workspace exists for a person who has already signed in, with that
 * person as its owner; there is no page for it by design, and the
 * enterprise shape (Entra group to workspace) belongs to WP-14. The
 * membership is written in the same transaction as the workspace, under
 * the owner's scope, as the tests and the e2e suite seed theirs.
 */
export interface CreateWorkspaceInput {
  name: string
  ownerEmail: string
}

export async function createWorkspace(
  input: CreateWorkspaceInput
): Promise<{ id: string; handle: string }> {
  const name = input.name.trim()
  if (!name || name.length > 200) throw new Error('a workspace name is required (1–200 characters)')
  const email = input.ownerEmail.trim().toLowerCase()
  // Identity is (tid, oid); an email can name more than one identity (a re-imported dev
  // realm did). The most recent one is the person who signs in today.
  const owner = await db
    .from('users')
    .whereRaw('lower(email) = ?', [email])
    .orderBy('created_at', 'desc')
    .first()
  if (!owner)
    throw new Error(
      `${input.ownerEmail} has not signed in yet: users exist only after their first sign-in, so sign in first`
    )
  const workspace = { id: randomUUID(), handle: newHandle() }
  await inScope({ userId: owner.id }, async (trx) => {
    await trx.table('workspaces').insert({ ...workspace, name, created_at: new Date() })
    await trx.table('workspace_memberships').insert({
      workspace_id: workspace.id,
      user_id: owner.id,
      role: 'owner',
      created_at: new Date(),
    })
  })
  securityEvents.emit('workspace.created', {
    workspaceId: workspace.id,
    ownerUserId: String(owner.id),
    requestId: '',
  })
  return workspace
}
