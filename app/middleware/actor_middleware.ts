// OpenTelemetry is not wired in this slice (no otel provider): the active span is a no-op
// until the telemetry slice lands. Actor scope (below) is independent of otel.
const trace = {
  getActiveSpan: (): { setAttribute(key: string, value: string): void } | undefined => undefined,
}
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { runWithActor, type Actor } from '#app/security/telemetry/actor_scope'

/**
 * Opens the actor scope for the rest of the request. Runs after
 * silent authentication so `auth.user` is resolved. Anonymous requests are
 * labelled as such rather than left unattributed.
 */
export default class ActorMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const user = ctx.auth?.user as { id?: string | number } | undefined
    const actor: Actor | undefined =
      user?.id !== undefined ? { kind: 'user', userId: String(user.id) } : undefined
    const span = trace.getActiveSpan()
    span?.setAttribute('app.request.id', ctx.request.id() ?? '')
    if (!actor) {
      span?.setAttribute('app.actor.kind', 'anonymous')
      return next()
    }
    return runWithActor(actor, () => next())
  }
}
