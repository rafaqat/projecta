import { Exception } from '@adonisjs/core/exceptions'
import { inScope, type Scope } from '#app/security/scope'
import { isAblated } from '#app/security/ablation_switch'

export interface Actor {
  userId: number
}

/**
 * Every read of tenant data goes through here: the application checks
 * membership first (a miss is a 404, never a hint), then the scoped
 * transaction lets row-level security enforce the same rule again.
 */
export class WorkspaceAccess {
  static async requireMembership(actor: Actor, workspaceId: string): Promise<Scope> {
    if (!(await isAblated('no_app_scope_checks'))) {
      const membership = await inScope({ userId: actor.userId }, (trx) =>
        trx
          .from('workspace_memberships')
          .where({ workspace_id: workspaceId, user_id: actor.userId })
          .first()
      )
      if (!membership) throw new Exception('Not found', { status: 404, code: 'E_NOT_FOUND' })
    }
    return { userId: actor.userId, workspaceId }
  }

  static async workspaces(actor: Actor, workspaceId: string) {
    const scope = await this.requireMembership(actor, workspaceId)
    return inScope(scope, (trx) =>
      trx.from('workspaces').where('id', workspaceId).select('id', 'handle', 'name')
    )
  }

  static async memberships(actor: Actor, workspaceId: string) {
    const scope = await this.requireMembership(actor, workspaceId)
    return inScope(scope, (trx) =>
      trx.from('workspace_memberships').where('workspace_id', workspaceId).select('user_id', 'role')
    )
  }

  static async repositories(actor: Actor, workspaceId: string) {
    const scope = await this.requireMembership(actor, workspaceId)
    return inScope(scope, (trx) =>
      trx
        .from('repositories')
        .where('workspace_id', workspaceId)
        .select('id', 'handle', 'name', 'url', 'visibility')
        .orderBy('name')
    )
  }

  static async repositoryMembers(actor: Actor, workspaceId: string) {
    const scope = await this.requireMembership(actor, workspaceId)
    return inScope(scope, (trx) =>
      trx
        .from('repository_members')
        .where('workspace_id', workspaceId)
        .select('repository_id', 'user_id')
    )
  }
}
