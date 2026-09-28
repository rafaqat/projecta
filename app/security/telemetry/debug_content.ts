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
 * Attributes that carry content, each with the size it is allowed to reach. They are absent from
 * the two standing allowlists and admitted only while `contentTelemetryEnabled()` holds, so the
 * default build exports none of them.
 *
 * The caps are per attribute because the attributes are not alike. A seed list is a handful of
 * identifiers; an evidence pack is a dozen paths; a tool result or an answer is prose and runs
 * long. One number for all of them was either too small for the long ones or wastefully large for
 * the short ones, and the first version clipped evidence packs silently at 2 KB.
 *
 * Nothing here is a platform limit. The SDK's own `attributeValueLengthLimit` defaults to
 * `Infinity`, the Collector accepts 4 MiB per message and Tempo allows megabytes per trace. What
 * these caps guard is repetition: an attribute set once per round is carried once per round, and
 * the turn's message array grows with every tool result it accumulates. Large content belongs on
 * the `turn` span, where it appears once.
 */
export const CONTENT_ATTRIBUTE_CAPS: Readonly<Record<string, number>> = {
  'app.turn.question': 4_096,
  'app.turn.answer': 16_384,
  'app.turn.withheld': 8_192,
  'app.tool.input': 4_096,
  'app.tool.output': 16_384,
  'app.evidence.paths': 16_384,
  'app.seed.names': 2_048,
}

/** Derived, so the allowlist and the caps cannot disagree about which attributes carry content. */
export const CONTENT_ATTRIBUTES: ReadonlySet<string> = new Set(Object.keys(CONTENT_ATTRIBUTE_CAPS))

/** An attribute with no declared cap is not a content attribute; this is the floor if one appears. */
export const CONTENT_ATTRIBUTE_DEFAULT_MAX = 2_048

export function capFor(key: string): number {
  return (
    CONTENT_ATTRIBUTE_CAPS[key as keyof typeof CONTENT_ATTRIBUTE_CAPS] ??
    CONTENT_ATTRIBUTE_DEFAULT_MAX
  )
}

/** Truncates to the cap and marks what was cut, so a reader never mistakes a prefix for the whole. */
export function contentValue(key: string, value: string): string {
  const cap = capFor(key)
  return value.length <= cap ? value : `${value.slice(0, cap)} [truncated ${value.length - cap}]`
}
