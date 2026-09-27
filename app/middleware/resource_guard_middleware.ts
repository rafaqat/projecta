import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { Exception } from '@adonisjs/core/exceptions'
import { AUTHORIZE_MIDDLEWARE, isResourceRoute } from '#app/security/route_policies'
import { securityEvents } from '#app/security/events/index'

/**
 * Runtime half of default-deny (SEC-22): a resource route that reached the
 * router without a declared policy is refused before its handler runs.
 */
export default class ResourceGuardMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const route = ctx.route
    if (route && isResourceRoute(route.pattern)) {
      const names = Array.from(route.middleware.all(), (m) =>
        typeof m === 'object' && 'name' in m ? m.name : ''
      )
      if (!names.includes(AUTHORIZE_MIDDLEWARE)) {
        securityEvents.emit('authz.denied', {
          policy: 'undeclared',
          resource: route.pattern,
          requestId: ctx.request.id() ?? '',
        })
        throw new Exception('Forbidden', { status: 403, code: 'E_AUTHORIZATION_FAILURE' })
      }
    }
    return next()
  }
}
