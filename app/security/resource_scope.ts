import { Exception } from '@adonisjs/core/exceptions'
import Repository from '#models/repository'
import Workspace from '#models/workspace'
import { isHandle } from '#app/security/handles'
import { inScope } from '#app/security/scope'

export interface ResourceScope {
  workspace: Workspace
  repository?: Repository
}

const notFound = () => new Exception('Not found', { status: 404, code: 'E_NOT_FOUND' })

/**
 * Resolves opaque URL handles to resources inside the actor's scope
 * (SEC-06). A handle from another workspace, a malformed handle
 * and a restricted repository the actor cannot see all look identical: 404.
 */
export async function resolveWorkspace(userId: number, handle: unknown): Promise<Workspace> {
  if (!isHandle(handle)) throw notFound()
  const workspace = await inScope({ userId }, (trx) =>
    Workspace.query({ client: trx }).where('handle', handle).first()
  )
  if (!workspace) throw notFound()
  return workspace
}

export async function resolveRepository(
  userId: number,
  workspace: Workspace,
  handle: unknown
): Promise<Repository> {
  if (!isHandle(handle)) throw notFound()
  const repository = await inScope({ userId, workspaceId: workspace.id }, (trx) =>
    Repository.query({ client: trx }).where({ handle, workspaceId: workspace.id }).first()
  )
  if (!repository) throw notFound()
  return repository
}
