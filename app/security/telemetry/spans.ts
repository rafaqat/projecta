import {
  context as otelContext,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from '@opentelemetry/api'

/**
 * The application's own spans (ADR-023). Auto-instrumentation covers the HTTP server, the database
 * and outbound calls, which is enough to see that a turn was slow and not enough to see why: the
 * scope decision, the seed ladder, each agent round and each tool are invisible in it.
 *
 * Attributes are the structural facts of a turn: counts, labels, statuses. Never its text. Content
 * goes to a log record instead (content_log.ts), because Tempo caps an attribute at 2048 bytes and
 * a question, an evidence pack or a request array is larger than that; a span carrying the first
 * 2 KB of something complete elsewhere is worse than a span not carrying it at all.
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

/** Sets attributes on a span if one is active; a no-op when tracing is off (tests, CLI). */
export function annotate(span: Span | undefined, attributes: Attributes): void {
  span?.setAttributes(attributes)
}
