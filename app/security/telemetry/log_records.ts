import { createHash } from 'node:crypto'
import type { Attributes } from '@opentelemetry/api'
import type { ExportResult } from '@opentelemetry/core'
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs'

/**
 * Log records leave the process under the same discipline as spans
 * (SEC-14): a pino record's structured fields are mapped onto named
 * attributes from this allowlist, and everything else, exception messages
 * and stacks above all, stays in the container's stdout. The collector's
 * redaction processor is the second, independent stage. Every key here is a
 * span attribute as well, so one collector allowlist covers both signals and
 * a security event reads the same on a span and in a log line.
 */
export const LOG_ATTRIBUTE_ALLOWLIST: ReadonlySet<string> = new Set([
  'app.security.event',
  'app.security.severity',
  'app.actor.kind',
  'user.id',
  'app.workspace.id',
  'app.request.id',
  'app.repository.id',
  'app.ingest.ref',
  'app.ingest.trigger',
  'app.job',
  'app.error.code',
  'app.error.hash',
  'app.policy.rule',
  'app.policy.decision',
  'http.response.status_code',
  'error.type',
])

interface SecurityEventShape {
  event?: unknown
  severity?: unknown
  actor?: { kind?: unknown; userId?: unknown; workspaceId?: unknown }
  fields?: Record<string, unknown>
}

const scalar = (value: unknown): string | number | boolean | undefined =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : undefined

/** The allowlisted attributes of one pino record (the object passed to the logger). */
export function logAttributesOf(record: Record<string, unknown>): Attributes {
  const out: Attributes = {}
  const put = (key: string, value: unknown) => {
    const v = scalar(value)
    if (v !== undefined && LOG_ATTRIBUTE_ALLOWLIST.has(key)) out[key] = v
  }
  const event = record.securityEvent as SecurityEventShape | undefined
  if (event && typeof event === 'object') {
    put('app.security.event', event.event)
    put('app.security.severity', event.severity)
    put('app.actor.kind', event.actor?.kind)
    put('user.id', event.actor?.userId)
    put('app.workspace.id', event.actor?.workspaceId)
    const fields = event.fields ?? {}
    put('app.error.code', fields.errorCode)
    put('app.error.hash', fields.errorHash)
    put('http.response.status_code', fields.status)
    put('app.request.id', fields.requestId)
    put('app.policy.rule', fields.rule)
    put('app.policy.decision', fields.decision)
    put('app.repository.id', fields.repositoryId)
  }
  // Attributes already flat on the record (a security event line carries its own).
  for (const key of LOG_ATTRIBUTE_ALLOWLIST) put(key, record[key])
  put('app.request.id', record.request_id ?? record.requestId ?? record.correlationId)
  put('app.repository.id', record.repositoryId)
  put('app.ingest.ref', record.ref)
  put('app.ingest.trigger', record.trigger)
  put('app.job', record.job)
  put('app.error.code', record.errorCode)
  put('app.error.hash', record.errorHash)
  put('http.response.status_code', record.status)
  const err = record.err as { type?: unknown; name?: unknown; code?: unknown } | undefined
  if (err && typeof err === 'object') {
    put('error.type', err.type ?? err.name)
    put('app.error.code', err.code)
  }
  return out
}

/** The attributes of a security event as a span event carries them. */
export function securityEventAttributes(record: {
  event: string
  severity: string
  actor?: { kind?: unknown; userId?: unknown; workspaceId?: unknown }
  fields: Record<string, unknown>
}): Attributes {
  return logAttributesOf({ securityEvent: record })
}

/**
 * Wraps the OTLP log exporter: every record goes out with its attributes
 * reduced to the allowlist and its body cut to a bounded message. The pino
 * bridge puts the record's fields on the log record as attributes, so the
 * mapping runs on those.
 */
export class AllowlistLogRecordExporter implements LogRecordExporter {
  constructor(private readonly inner: LogRecordExporter) {}

  export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    this.inner.export(logs.map(withAllowlistedAttributes), resultCallback)
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown()
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve()
  }
}

const BODY_LIMIT = 160

/**
 * The exported text of a record. A record that carries an exception (`err`)
 * is described by the exception's type, code and a hash of its message, as
 * the exception handler does: the message itself, and a `msg` that
 * might be one, never leave. Other records keep their own short message.
 */
export function exportedBodyOf(record: Record<string, unknown>, body: unknown): string {
  const err = record.err as
    { type?: unknown; name?: unknown; code?: unknown; message?: unknown } | undefined
  if (err && typeof err === 'object') {
    const type = String(err.type ?? err.name ?? 'Error')
    const code = String(err.code ?? record.errorCode ?? 'E_UNHANDLED')
    const hash = createHash('sha256')
      .update(String(err.message ?? ''))
      .digest('hex')
      .slice(0, 16)
    return `${type} ${code} ${hash}`
  }
  return typeof body === 'string' ? body.slice(0, BODY_LIMIT) : ''
}

function withAllowlistedAttributes(log: ReadableLogRecord): ReadableLogRecord {
  const record = log.attributes as Record<string, unknown>
  const attributes = logAttributesOf(record)
  const body = exportedBodyOf(record, log.body)
  return new Proxy(log, {
    get: (target, property, receiver) =>
      property === 'attributes'
        ? attributes
        : property === 'body'
          ? body
          : Reflect.get(target, property, receiver),
  })
}
