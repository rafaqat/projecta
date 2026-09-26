import type { Context } from '@opentelemetry/api'
import type { Span, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { currentActor } from '#app/security/telemetry/actor_scope'

/**
 * Stamps the current actor on every span at creation, so attribution does
 * not depend on each instrumented call site remembering to do it.
 */
export class ActorSpanProcessor implements SpanProcessor {
  onStart(span: Span, _parentContext: Context): void {
    const actor = currentActor()
    if (!actor) return
    span.setAttribute('app.actor.kind', actor.kind)
    if (actor.kind === 'user') {
      span.setAttribute('user.id', actor.userId)
      if (actor.workspaceId) span.setAttribute('app.workspace.id', actor.workspaceId)
    } else {
      span.setAttribute('app.job', actor.job)
    }
  }

  onEnd(): void {}

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}
