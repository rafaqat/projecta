import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { Exception } from '@adonisjs/core/exceptions'
import RepositoryPolicy from '#policies/repository_policy'
import WorkspacePolicy from '#policies/workspace_policy'
import {
  resolveRepository,
  resolveWorkspace,
  type ResourceScope,
} from '#app/security/resource_scope'
import { isAblated } from '#app/security/ablation_switch'
import { securityEvents } from '#app/security/events/index'

export type Resource = 'workspace' | 'repository'

export interface AuthorizeOptions {
  resource: Resource
  ability: 'view' | 'manage'
}

/**
 * The declared Bouncer policy for a resource route (SEC-22).
 * Resolves the route's handles inside the actor's scope, authorises through
 * the policy, and exposes the resources on the context. Any error while
 * evaluating denies (SEC-39); only the test ablation can flip that.
 */
export default class AuthorizeMiddleware {
  async handle(ctx: HttpContext, next: NextFn, options: AuthorizeOptions) {
    const user = ctx.auth.getUserOrFail()
    const workspace = await resolveWorkspace(user.id, ctx.params.workspace)
    const scope: ResourceScope = { workspace }
    if (options.resource === 'repository') {
      scope.repository = await resolveRepository(user.id, workspace, ctx.params.repository)
    }
    try {
      if (options.resource === 'repository') {
        await ctx.bouncer.with(RepositoryPolicy).authorize('view', scope.repository!)
        // Managing a repository (re-index, delete) is the workspace's manage ability,
        // checked after the repository resolved and is viewable: a stranger still gets 404.
        if (options.ability === 'manage')
          await ctx.bouncer.with(WorkspacePolicy).authorize('manage', workspace)
      } else {
        if (options.ability === 'manage')
          await ctx.bouncer.with(WorkspacePolicy).authorize('manage', workspace)
        else await ctx.bouncer.with(WorkspacePolicy).authorize('view', workspace)
      }
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'E_AUTHORIZATION_FAILURE') throw error
      if (await isAblated('fail_open_on_policy_error')) {
        ctx.logger.warn('ablation fail_open_on_policy_error: allowing after policy error')
      } else {
        securityEvents.emit('authz.denied', {
          policy: `${options.resource}.${options.ability}`,
          resource: options.resource,
          requestId: ctx.request.id() ?? '',
        })
        throw new Exception('Forbidden', {
          status: 403,
          code: 'E_AUTHORIZATION_FAILURE',
          cause: error,
        })
      }
    }
    ctx.scope = scope
    return next()
  }
}

declare module '@adonisjs/core/http' {
  export interface HttpContext {
    scope: ResourceScope
  }
}
