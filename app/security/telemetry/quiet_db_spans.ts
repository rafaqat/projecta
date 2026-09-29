import { SpanStatusCode } from '@opentelemetry/api'
import type { ExportResult } from '@opentelemetry/core'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { appMetrics } from '#app/security/telemetry/metrics'

/**
 * Drops the fast database spans from a trace, and counts what it dropped.
 *
 * One answered turn produced 697 spans, of which about 684 were sub-millisecond queries. The turn
 * itself, its rounds and its tool calls were in there, and unreadable: a waterfall is the wrong
 * instrument when almost every bar is a 600-microsecond `select`.
 *
 * The trade-off is real and is the reason for the counter rather than a silent drop. Individual
 * fast queries stop being visible, and an N+1 shows up as a burst of identical spans, which is
 * exactly the shape this removes. So the count survives as `app.db.spans.dropped`: the spans go,
 * the volume does not, and a query storm is still a spike on a graph. A slow query is kept, and an
 * errored one always is, because those are the ones a trace is opened for.
 *
 * Off unless `OTEL_DB_SPAN_MIN_MS` is set, so a deployment keeps every span until someone decides
 * otherwise. The developer stack sets it (docker/compose.yml).
 */
const NANOS_PER_MS = 1e6

function thresholdMs(): number {
  const raw = Number(process.env.OTEL_DB_SPAN_MIN_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

/** A database client span is one the pg/knex instrumentation named with a system. */
function isDatabaseSpan(span: ReadableSpan): boolean {
  return (
    span.attributes['db.system.name'] !== undefined || span.attributes['db.system'] !== undefined
  )
}

function durationMs(span: ReadableSpan): number {
  return span.duration[0] * 1000 + span.duration[1] / NANOS_PER_MS
}

export function keepsSpan(span: ReadableSpan, minMs: number): boolean {
  if (minMs <= 0 || !isDatabaseSpan(span)) return true
  if (span.status.code === SpanStatusCode.ERROR) return true
  return durationMs(span) >= minMs
}

export class QuietDatabaseSpanExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly minMs = thresholdMs()
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.minMs <= 0) return this.inner.export(spans, resultCallback)
    const kept = spans.filter((span) => keepsSpan(span, this.minMs))
    const dropped = spans.length - kept.length
    if (dropped > 0) appMetrics.databaseSpansDropped(dropped)
    this.inner.export(kept, resultCallback)
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown()
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve()
  }
}
