/**
 * Content telemetry, for debugging and security operations on a developer's own stack.
 *
 * SEC-14 keeps request content out of telemetry: no bodies, no messages, no URLs, no SQL. That is
 * the right default and it stays the default. But the same policy makes a turn hard to reconstruct
 * when you are the person who wrote it and the repository is your own, so this opens the question,
 * the evidence and the tool arguments to the exporter, and nothing else.
 *
 * Two keys, and a third held elsewhere:
 *
 *  1. `TELEMETRY_DEBUG_CONTENT=1` must be set.
 *  2. `APP_ENV` must be a developer's environment. uat and production are not, so a flag that
 *     escapes into a deployed environment turns nothing on.
 *  3. The collector's `redaction` processor allowlists attributes independently
 *     (`docker/otel/collector.yaml`). A deployment that never adds these keys drops them whatever
 *     the application does.
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

/**
 * Attributes that carry content. They are absent from the two standing allowlists and admitted
 * only while `contentTelemetryEnabled()` holds, so the default build exports none of them.
 */
export const CONTENT_ATTRIBUTES: ReadonlySet<string> = new Set([
  'app.turn.question',
  'app.turn.answer',
  'app.turn.withheld',
  'app.tool.input',
  'app.tool.output',
  'app.evidence.paths',
  'app.seed.names',
  'app.scope.reason',
])

/** The cap on any one content attribute, so a large evidence pack cannot fill the exporter. */
export const CONTENT_ATTRIBUTE_MAX = 2048

/** Truncates to the cap and marks what was cut, so a reader never mistakes a prefix for the whole. */
export function contentValue(value: string): string {
  return value.length <= CONTENT_ATTRIBUTE_MAX
    ? value
    : `${value.slice(0, CONTENT_ATTRIBUTE_MAX)} [truncated ${value.length - CONTENT_ATTRIBUTE_MAX}]`
}
