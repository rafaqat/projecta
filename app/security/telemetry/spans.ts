import { SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api'
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
 * A span the caller ends itself. The agent loop is an async generator, so its rounds cannot be
 * wrapped in a callback without changing how it yields; they start and end a span instead.
 */
export function startSpan(name: string, attributes: Attributes = {}): Span {
  return tracer().startSpan(name, { attributes })
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
    if (value !== undefined && value !== '') attributes[key] = contentValue(value)
  }
  return attributes
}

/** Sets attributes on a span if one is active; a no-op when tracing is off (tests, CLI). */
export function annotate(span: Span | undefined, attributes: Attributes): void {
  span?.setAttributes(attributes)
}
