import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import type { Authenticators } from '@adonisjs/auth/types'

/**
 * Auth middleware authenticates HTTP requests and denies access to
 * unauthenticated users.
 *
 * A browser navigation to a page is redirected to sign-in. An `/api/` request
 * — the SPA's `fetch`/SSE calls — is answered 401 instead, never a 302: a
 * redirect there is followed by `fetch` to an HTML page, which the client
 * cannot use, so an expired session left the UI half-working until a reload
 * (UAT 2026-09-17). A 401 lets the client re-authenticate in a full-window
 * navigation. The `/api/` prefix is this app's convention for XHR routes.
 */
export default class AuthMiddleware {
  /**
   * The URL to redirect to, when authentication fails
   */
  redirectTo = '/auth/login'

  async handle(
    ctx: HttpContext,
    next: NextFn,
    options: {
      guards?: (keyof Authenticators)[]
    } = {}
  ) {
    const isApi = ctx.request.url().startsWith('/api/')
    try {
      await ctx.auth.authenticateUsing(
        options.guards,
        isApi ? undefined : { loginRoute: this.redirectTo }
      )
    } catch (error) {
      if (isApi && (error as { code?: string }).code === 'E_UNAUTHORIZED_ACCESS') {
        return ctx.response.status(401).send({ errors: [{ message: 'Unauthorized' }] })
      }
      throw error
    }
    return next()
  }
}
