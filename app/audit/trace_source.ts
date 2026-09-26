import env from '#start/env'

/**
 * A runtime span, normalized for the Traces page: its name, kind, depth in the call
 * tree, offset from the trace start and duration, plus the allowlisted attributes the exporter let
 * through. No content — the AllowlistSpanExporter strips everything else on export (INV-03/04).
 */
export interface RuntimeSpan {
  name: string
  kind: string
  depth: number
  startMs: number
  durationMs: number
  attributes: Array<{ key: string; value: string }>
}

export interface RuntimeTrace {
  traceId: string
  root: string
  totalMs: number
  spans: RuntimeSpan[]
}

/** Reads a trace by id from the telemetry backend; null when unset or the trace has expired. */
export interface TraceSource {
  readonly id: string
  trace(traceId: string): Promise<RuntimeTrace | null>
}

const KIND: Record<string, string> = {
  SPAN_KIND_SERVER: 'server',
  SPAN_KIND_CLIENT: 'client',
  SPAN_KIND_INTERNAL: 'internal',
  SPAN_KIND_PRODUCER: 'producer',
  SPAN_KIND_CONSUMER: 'consumer',
}

/** Attributes worth showing on a span: request, actor and tool shape — never content. */
const SHOWN_ATTRS =
  /^(http\.(request\.method|route|response\.status_code)|db\.(operation\.name|system\.name)|workspace\.id|user\.id|app\.(turn|tool|actor)\.|turn$|tool_calls$|max_iterations$)/

interface OtlpSpan {
  name?: string
  kind?: string
  spanId?: string
  parentSpanId?: string
  startTimeUnixNano?: string
  endTimeUnixNano?: string
  attributes?: Array<{ key: string; value?: Record<string, unknown> }>
}

function attrValue(v: Record<string, unknown> | undefined): string {
  if (!v) return ''
  if ('stringValue' in v) return String(v.stringValue)
  if ('intValue' in v) return String(v.intValue)
  if ('boolValue' in v) return String(v.boolValue)
  if ('doubleValue' in v) return String(v.doubleValue)
  return ''
}

/** Turns Tempo's OTLP trace JSON into a normalized, content-free RuntimeTrace. */
export function normalizeTempoTrace(traceId: string, body: unknown): RuntimeTrace | null {
  const batches = (body as { batches?: unknown[] })?.batches ?? []
  const flat: OtlpSpan[] = []
  for (const b of batches as Array<Record<string, unknown>>) {
    const scopes = (b.scopeSpans ?? b.instrumentationLibrarySpans ?? []) as Array<{
      spans?: OtlpSpan[]
    }>
    for (const sc of scopes) for (const s of sc.spans ?? []) flat.push(s)
  }
  if (flat.length === 0) return null

  const byId = new Map<string, OtlpSpan>()
  for (const s of flat) if (s.spanId) byId.set(s.spanId, s)
  const depthOf = (s: OtlpSpan): number => {
    let d = 0
    let cur = s
    const seen = new Set<string>()
    while (cur.parentSpanId && byId.has(cur.parentSpanId) && !seen.has(cur.parentSpanId)) {
      seen.add(cur.parentSpanId)
      cur = byId.get(cur.parentSpanId)!
      d++
      if (d > 20) break
    }
    return d
  }

  const nanos = flat.map((s) => Number(s.startTimeUnixNano ?? 0)).filter((n) => n > 0)
  const min = nanos.length ? Math.min(...nanos) : 0
  const max = Math.max(...flat.map((s) => Number(s.endTimeUnixNano ?? 0)))

  const spans: RuntimeSpan[] = flat
    .map((s) => {
      const start = Number(s.startTimeUnixNano ?? 0)
      const end = Number(s.endTimeUnixNano ?? start)
      return {
        name: String(s.name ?? 'span'),
        kind: KIND[String(s.kind ?? '')] ?? 'internal',
        depth: depthOf(s),
        startMs: (start - min) / 1e6,
        durationMs: (end - start) / 1e6,
        attributes: (s.attributes ?? [])
          .filter((a) => SHOWN_ATTRS.test(a.key))
          .map((a) => ({ key: a.key, value: attrValue(a.value) }))
          .slice(0, 6),
      }
    })
    .sort((a, b) => a.startMs - b.startMs || a.depth - b.depth)

  const root = flat.find((s) => !s.parentSpanId || !byId.has(s.parentSpanId))
  return {
    traceId,
    root: String(root?.name ?? spans[0]?.name ?? traceId),
    totalMs: min && max ? (max - min) / 1e6 : 0,
    spans,
  }
}

/** Tempo query API adapter. */
export function tempoTraceSource(url: string): TraceSource {
  return {
    id: 'tempo',
    async trace(traceId) {
      if (!/^[0-9a-f]{16,32}$/i.test(traceId)) return null
      try {
        const res = await fetch(`${url.replace(/\/$/, '')}/api/traces/${traceId}`, {
          headers: { accept: 'application/json' },
        })
        if (!res.ok) return null
        return normalizeTempoTrace(traceId, await res.json())
      } catch {
        return null
      }
    },
  }
}

/** No backend configured (e.g. production before its adapter is wired): the tab is disabled. */
export const disabledTraceSource: TraceSource = {
  id: 'disabled',
  async trace() {
    return null
  },
}

let cached: TraceSource | undefined
export function defaultTraceSource(): TraceSource {
  if (!cached) {
    const url = env.get('TEMPO_QUERY_URL')
    cached = url ? tempoTraceSource(url) : disabledTraceSource
  }
  return cached
}
