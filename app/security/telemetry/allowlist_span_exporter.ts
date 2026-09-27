import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import type { ExportResult } from '@opentelemetry/core'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { SPAN_ATTRIBUTE_ALLOWLIST } from '#app/security/telemetry/allowlist'

/**
 * Wraps any exporter and hands it spans whose attributes are reduced to the
 * allowlist. Wrapping the exporter, rather than mutating spans in a
 * processor, catches attributes set at any point in the span's life.
 */
export class AllowlistSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.inner.export(spans.map(withAllowlistedAttributes), resultCallback)
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown()
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve()
  }
}

function allowlisted(source: ReadableSpan['attributes']): ReadableSpan['attributes'] {
  const attributes: ReadableSpan['attributes'] = {}
  for (const [key, value] of Object.entries(source)) {
    if (SPAN_ATTRIBUTE_ALLOWLIST.has(key)) attributes[key] = value
  }
  return attributes
}

/**
 * On an inbound (SERVER) span, a 4xx is a client error — a bad request, a request for a resource the
 * caller may not see (404), a missing credential (401) — not a fault of this service. Left as
 * ERROR it fills the secops dashboards' error view with noise, so it is reduced to UNSET and only
 * 5xx (and non-HTTP failures) stay errors. Outbound (CLIENT) spans keep their status: a 4xx we
 * received from a dependency (e.g. the gateway answering 401/413) is a real problem to surface.
 */
function normalisedStatus(span: ReadableSpan): ReadableSpan['status'] {
  if (span.kind !== SpanKind.SERVER || span.status.code !== SpanStatusCode.ERROR) return span.status
  const code = Number(
    span.attributes['http.response.status_code'] ?? span.attributes['http.status_code']
  )
  if (Number.isFinite(code) && code >= 400 && code < 500) return { code: SpanStatusCode.UNSET }
  return span.status
}

/** Span attributes and the attributes of every span event (security events ride there). */
function withAllowlistedAttributes(span: ReadableSpan): ReadableSpan {
  const attributes = allowlisted(span.attributes)
  const events = span.events.map((event) => ({
    ...event,
    attributes: allowlisted(event.attributes ?? {}),
  }))
  const status = normalisedStatus(span)
  return new Proxy(span, {
    get: (target, property, receiver) =>
      property === 'attributes'
        ? attributes
        : property === 'events'
          ? events
          : property === 'status'
            ? status
            : Reflect.get(target, property, receiver),
  })
}
