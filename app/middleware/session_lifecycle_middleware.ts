import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import {
  clock,
  judgeSession,
  SESSION_LAST_SEEN_AT,
  SESSION_STARTED_AT,
} from '#app/auth/session_policy'
import { securityEvents } from '#app/security/events/index'

/**
 * Idle and absolute session timeouts (SEC-37). Runs after silent
 * authentication: an expired session is destroyed server-side and the
 * request continues unauthenticated, so `auth` middleware answers 401.
 */
export default class SessionLifecycleMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    if (ctx.auth.user) {
      const now = clock.now()
      const verdict = judgeSession(
        ctx.session.get(SESSION_STARTED_AT),
        ctx.session.get(SESSION_LAST_SEEN_AT),
        now
      )
      if (verdict === 'valid') {
        ctx.session.put(SESSION_LAST_SEEN_AT, now)
      } else {
        securityEvents.emit('auth.sign_in.failed', {
          issuer: 'session',
          reason: verdict,
          requestId: ctx.request.id() ?? '',
        })
        await ctx.auth.use('web').logout()
        ctx.session.clear()
        ctx.session.regenerate()
      }
    }
    return next()
  }
}
