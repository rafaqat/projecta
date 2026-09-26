import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { staticSecurityHeaders } from '#app/security/headers'

/**
 * Sets the headers Shield does not manage, on every response including
 * static files and unmatched routes.
 */
export default class SecurityHeadersMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    for (const [name, value] of Object.entries(staticSecurityHeaders)) {
      ctx.response.header(name, value)
    }
    return next()
  }
}
