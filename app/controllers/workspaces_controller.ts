import type { HttpContext } from '@adonisjs/core/http'
import Repository from '#models/repository'
import Workspace from '#models/workspace'
import WorkspaceMembership from '#models/workspace_membership'
import WorkspacePolicy from '#policies/workspace_policy'
import RepositoryTransformer from '#transformers/repository_transformer'
import WorkspaceTransformer from '#transformers/workspace_transformer'
import { inScope } from '#app/security/scope'

export default class WorkspacesController {
  /** The signed-in user's workspaces (their own memberships, via RLS). */
  async index({ auth, inertia }: HttpContext) {
    const user = auth.getUserOrFail()
    const workspaces = await inScope({ userId: user.id }, (trx) =>
      Workspace.query({ client: trx }).orderBy('name')
    )
    return inertia.render('workspaces/index', {
      workspaces: WorkspaceTransformer.transform(workspaces),
    })
  }

  /** Repositories visible to the actor in this workspace (ACL applied by RLS and policy). */
  async show({ auth, bouncer, scope, inertia }: HttpContext) {
    const user = auth.getUserOrFail()
    const repositories = await inScope(
      { userId: user.id, workspaceId: scope.workspace.id },
      (trx) =>
        Repository.query({ client: trx }).where('workspaceId', scope.workspace.id).orderBy('name')
    )
    return inertia.render('workspaces/show', {
      workspace: WorkspaceTransformer.transform(scope.workspace),
      repositories: RepositoryTransformer.transform(repositories),
      // The same policy the registration route enforces; the page only shows the form.
      canManage: await bouncer.with(WorkspacePolicy).allows('manage', scope.workspace),
    })
  }

  async members({ auth, scope }: HttpContext) {
    const user = auth.getUserOrFail()
    const memberships = await inScope({ userId: user.id, workspaceId: scope.workspace.id }, (trx) =>
      WorkspaceMembership.query({ client: trx })
        .where('workspaceId', scope.workspace.id)
        .preload('user')
    )
    return {
      members: memberships.map((m) => ({
        role: m.role,
        fullName: m.user?.fullName ?? null,
        initials: m.user?.initials,
      })),
    }
  }
}
