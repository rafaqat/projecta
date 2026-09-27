import Repository from '#models/repository'
import Workspace from '#models/workspace'
import { inScope } from '#app/security/scope'

/**
 * Where a freshly signed-in user lands. A user with exactly one workspace and
 * exactly one repository they can see goes straight to that repository's
 * thread; otherwise they land on the narrowest list that still needs a choice.
 * Visibility is decided by row-level security inside `inScope`, never here.
 */
export async function landingPathFor(userId: number): Promise<string> {
  const workspaces = await inScope({ userId }, (trx) => Workspace.query({ client: trx }))
  if (workspaces.length !== 1) return '/workspaces'

  const [workspace] = workspaces
  const repositories = await inScope({ userId, workspaceId: workspace.id }, (trx) =>
    Repository.query({ client: trx }).where('workspaceId', workspace.id)
  )
  if (repositories.length !== 1) return `/w/${workspace.handle}`

  return `/w/${workspace.handle}/r/${repositories[0].handle}`
}
