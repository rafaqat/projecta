import {
  context as otelContext,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from '@opentelemetry/api'
import { contentTelemetryEnabled, contentValue } from '#app/security/telemetry/debug_content'

/**
 * The application's own spans (ADR-023). Auto-instrumentation covers the HTTP server, the database
 * and outbound calls, which is enough to see that a turn was slow and not enough to see why: the
 * scope decision, the seed ladder, each agent round and each tool are invisible in it.
 *
 * Attributes are the structural facts of a turn (counts, labels, statuses) and pass the standing
 * allowlist. Content rides only under `content()`, which returns nothing unless
 * `contentTelemetryEnabled()` holds, so a production span carries the shape of a turn and never its
 * text.
 */
const TRACER = 'projectA'

const tracer = () => trace.getTracer(TRACER)

/** Runs `fn` inside a span, recording a thrown error as the span's status before rethrowing. */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span)
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      span.end()
    }
  })
}

/**
 * A span the caller ends itself, optionally under an explicit parent.
 *
 * The turn and the agent loop are async generators. OpenTelemetry's context is bound to the async
 * execution, and a generator suspends at every yield and resumes on the consumer's stack, so the
 * context that was active when a span opened is gone by the time the next round runs. Relying on
 * the ambient context therefore produced a flat trace: every span a sibling of the HTTP span,
 * lost among the database spans, with no loop to read. The parent is passed explicitly instead.
 */
export function startSpan(name: string, attributes: Attributes = {}, parent?: Span): Span {
  const ctx = parent ? trace.setSpan(otelContext.active(), parent) : otelContext.active()
  return tracer().startSpan(name, { attributes }, ctx)
}

/** The active span, for attaching a fact discovered after the span was opened. */
export function currentSpan(): Span | undefined {
  return trace.getActiveSpan()
}

/**
 * Content attributes, or nothing. Every call site passes content through here rather than checking
 * the flag itself, so there is one place where the decision is made and one place to audit. Values
 * are capped, and an undefined value is dropped rather than exported as "undefined".
 */
export function contentAttributes(values: Record<string, string | undefined>): Attributes {
  if (!contentTelemetryEnabled()) return {}
  const attributes: Attributes = {}
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') attributes[key] = contentValue(key, value)
  }
  return attributes
}

/** Sets attributes on a span if one is active; a no-op when tracing is off (tests, CLI). */
export function annotate(span: Span | undefined, attributes: Attributes): void {
  span?.setAttributes(attributes)
}
