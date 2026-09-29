/**
 * Content telemetry, for debugging and security operations on a developer's own stack.
 *
 * SEC-14 keeps request content out of telemetry: no bodies, no messages, no URLs, no SQL. That is
 * the right default and it stays the default. But the same policy makes a turn hard to reconstruct
 * when you are the person who wrote it and the repository is your own, so this opens one path for
 * it: a log record whose body carries the content (content_log.ts), and nothing else. Spans stay
 * structural, because Tempo truncates an attribute at 2048 bytes and half a question is worse than
 * no question.
 *
 * Two keys, and a third held elsewhere:
 *
 *  1. `TELEMETRY_DEBUG_CONTENT=1` must be set.
 *  2. `APP_ENV` must be a developer's environment. uat and production are not, so a flag that
 *     escapes into a deployed environment turns nothing on.
 *  3. The collector's `redaction` processor allowlists `app.content.kind` independently
 *     (`docker/otel/collector.yaml`), and `exportedBodyOf` keeps a record's body only for a record
 *     that declares it. A deployment that never adds that key drops the label whatever the
 *     application does.
 *
 * `evaluateBootGuards` additionally refuses to start uat or production with the flag set, so the
 * failure is loud at boot rather than silent at export.
 */

/** Environments where a developer owns both the stack and the data in it. */
const DEVELOPER_ENVIRONMENTS = new Set(['local', 'test'])

export interface ContentTelemetryEnv {
  TELEMETRY_DEBUG_CONTENT?: string | undefined
  APP_ENV?: string | undefined
}

/**
 * Whether content may be attached to spans and log records. Read per call rather than cached: a
 * test flips it, and the cost is a map lookup against the cost of exporting a prompt by accident.
 */
export function contentTelemetryEnabled(
  env: ContentTelemetryEnv = process.env as ContentTelemetryEnv
): boolean {
  if (env.TELEMETRY_DEBUG_CONTENT !== '1') return false
  return DEVELOPER_ENVIRONMENTS.has(env.APP_ENV ?? '')
}
