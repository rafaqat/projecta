import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

/** The public share-link prefix: the one place tenant data leaves without a session. */
export const SHARE_PREFIX = '/s/'

/**
 * Share-link responses set no cookie (AC-WP23-01). Session and CSRF middleware run on
 * every router route and write their cookies after the handler returns, so no route-level code can
 * stop them; this runs outermost, after the whole chain, and removes them. An anonymous fetcher —
 * a CI job, a link-preview bot — is thereby never handed a session or an XSRF token.
 */
export default class ShareRouteMiddleware {
  async handle({ request, response }: HttpContext, next: NextFn) {
    await next()
    if (request.url().startsWith(SHARE_PREFIX)) response.removeHeader('set-cookie')
  }
}
