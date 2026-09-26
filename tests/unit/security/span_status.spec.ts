import { test } from '@japa/runner'
import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import type { ExportResult } from '@opentelemetry/core'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { AllowlistSpanExporter } from '#app/security/telemetry/allowlist_span_exporter'

/**
 * A 4xx on an inbound request is a client error, not a fault of this service, so it must not fill
 * the secops dashboards' error view. The exporter reduces such a span's status to UNSET;
 * 5xx and non-HTTP failures stay errors, and an outbound 4xx (a dependency answering 401/413) is
 * kept as an error because it is a real problem to surface.
 */
function span(kind: SpanKind, status: ReadableSpan['status'], statusCode?: number): ReadableSpan {
  return {
    kind,
    status,
    attributes: statusCode ? { 'http.response.status_code': statusCode } : {},
    events: [],
  } as unknown as ReadableSpan
}

class Capture implements SpanExporter {
  captured: ReadableSpan[] = []
  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.captured = spans
    done({ code: 0 } as ExportResult)
  }
  shutdown(): Promise<void> {
    return Promise.resolve()
  }
}

function exportedStatus(input: ReadableSpan): ReadableSpan['status'] {
  const inner = new Capture()
  new AllowlistSpanExporter(inner).export([input], () => {})
  return inner.captured[0].status
}

test.group('span status normalisation', () => {
  test('a 4xx SERVER span is reduced from ERROR to UNSET', ({ assert }) => {
    const out = exportedStatus(
      span(SpanKind.SERVER, { code: SpanStatusCode.ERROR, message: 'Not found' }, 404)
    )
    assert.equal(out.code, SpanStatusCode.UNSET)
  }).tags(['wp-observability', 'telemetry'])

  test('a 5xx SERVER span stays ERROR', ({ assert }) => {
    const out = exportedStatus(span(SpanKind.SERVER, { code: SpanStatusCode.ERROR }, 503))
    assert.equal(out.code, SpanStatusCode.ERROR)
  }).tags(['wp-observability', 'telemetry'])

  test('a 4xx CLIENT span keeps ERROR (a dependency answering 4xx is a real problem)', ({
    assert,
  }) => {
    const out = exportedStatus(span(SpanKind.CLIENT, { code: SpanStatusCode.ERROR }, 401))
    assert.equal(out.code, SpanStatusCode.ERROR)
  }).tags(['wp-observability', 'telemetry'])

  test('a successful SERVER span is left untouched', ({ assert }) => {
    const out = exportedStatus(span(SpanKind.SERVER, { code: SpanStatusCode.UNSET }, 200))
    assert.equal(out.code, SpanStatusCode.UNSET)
  }).tags(['wp-observability', 'telemetry'])
})
