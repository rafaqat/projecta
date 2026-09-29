import logger from '@adonisjs/core/services/logger'
import { contentTelemetryEnabled } from '#app/security/telemetry/debug_content'

/**
 * Turn content as a log record, for the part that will not fit on a span.
 *
 * Tempo truncates a span attribute at 2048 bytes by default, so `app.model.messages` carries the
 * first 2 KB of the request and an exact count of what was cut. The whole of it goes here instead:
 * Loki's line limit is orders of magnitude larger, the OpenTelemetry bridge stamps every record
 * with its trace and span id, and the dashboard joins the two by `trace_id`.
 *
 * The body is not an unguarded path, which is worth being exact about. `exportedBodyOf` caps every
 * record's body at 160 bytes precisely so an exception message cannot leave inside a `msg`, and a
 * record carrying an `err` is reduced to its type, code and a hash. This is the single named
 * exception to that: a record that declares `app.content.kind` keeps its whole body, and only while
 * `contentTelemetryEnabled()` holds, which is also the condition this function returns on. So the
 * limit stands for everything else and the exception is visible in both places rather than being a
 * gap someone finds later.
 */
export type ContentKind = 'messages' | 'answer' | 'withheld' | 'turn'

export function logTurnContent(
  kind: ContentKind,
  payload: string,
  requestId = '',
  runHandle = ''
): boolean {
  if (!contentTelemetryEnabled() || !payload) return false
  // The field names are the exported attribute names: log_records.ts copies any flat key that is
  // on the allowlist, so no mapping has to be kept in step with this call site. The run handle is
  // here because it is the identifier a reader already has: it is on the turn span, in the turns
  // table and on the page, so one value finds every record for a turn.
  logger.info(
    { 'app.content.kind': kind, 'app.request.id': requestId, 'app.turn.run_handle': runHandle },
    payload
  )
  return true
}
