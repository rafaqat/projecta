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
 * The ceiling is the backend's, not the SDK's. The SDK's `attributeValueLengthLimit` defaults to
 * `Infinity` and the Collector accepts 4 MiB per message, but Tempo truncates a span attribute at
 * `max_attribute_bytes`, which defaults to 2048 and cuts silently with no marker. Measured: an
 * evidence text capped here at 64 KB arrived in Tempo at 2038 characters, which reads as an
 * application bug and is not one.
 *
 * So the caps sit just under that ceiling. The value is that truncation is then ours and says so,
 * rather than the backend's and silent. Raising Tempo's limit means replacing the config baked into
 * the otel-lgtm image, which its Tempo rejects; carrying more than 2 KB of content wants a log
 * record, where Loki's line limit is far higher, rather than a span attribute.
 *
 * The caps still differ per attribute because the attributes differ, and because a deployment with
 * a Tempo of its own may raise the ceiling. `CONTENT_MARKER_HEADROOM` keeps the `[truncated N]`
 * suffix inside the ceiling so the marker itself is not what gets cut.
 */
/**
 * The backend's ceiling on one attribute, less room for the truncation marker so the marker is not
 * itself what gets cut. Tempo's `max_attribute_bytes` defaults to 2048; a deployment that raises it
 * sets `OTEL_ATTRIBUTE_CEILING_BYTES` to match and the semantic caps below take effect.
 */
export function attributeCeiling(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OTEL_ATTRIBUTE_CEILING_BYTES)
  return (Number.isFinite(raw) && raw > 0 ? raw : 2_048) - 48
}

export const CONTENT_ATTRIBUTE_CAPS: Readonly<Record<string, number>> = {
  'app.turn.question': 4_096,
  'app.turn.answer': 16_384,
  'app.turn.withheld': 8_192,
  'app.tool.input': 4_096,
  'app.tool.output': 16_384,
  'app.evidence.paths': 16_384,
  // The largest single thing in a turn and the reason the caps are per attribute: this is the
  // evidence as the model reads it, set once on the turn span rather than per round.
  'app.evidence.text': 65_536,
  // The literal message array as the loop last held it. Append-only within a turn, so the final
  // state is a superset of every earlier one: captured once at the end rather than per round, which
  // is what keeps a six-round turn from storing its own evidence six times.
  'app.model.messages': 262_144,
  'app.seed.names': 2_048,
}

/** Derived, so the allowlist and the caps cannot disagree about which attributes carry content. */
export const CONTENT_ATTRIBUTES: ReadonlySet<string> = new Set(Object.keys(CONTENT_ATTRIBUTE_CAPS))

/** An attribute with no declared cap is not a content attribute; this is the floor if one appears. */
export const CONTENT_ATTRIBUTE_DEFAULT_MAX = 2_048

/**
 * What an attribute may reach: the smaller of what it needs and what the backend will carry. The
 * two are separate because the first is a property of the data and the second of the deployment.
 */
export function capFor(key: string, env: NodeJS.ProcessEnv = process.env): number {
  const declared =
    CONTENT_ATTRIBUTE_CAPS[key as keyof typeof CONTENT_ATTRIBUTE_CAPS] ??
    CONTENT_ATTRIBUTE_DEFAULT_MAX
  return Math.min(declared, attributeCeiling(env))
}

/** Truncates to the cap and marks what was cut, so a reader never mistakes a prefix for the whole. */
export function contentValue(key: string, value: string): string {
  const cap = capFor(key)
  return value.length <= cap ? value : `${value.slice(0, cap)} [truncated ${value.length - cap}]`
}
