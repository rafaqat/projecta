/**
 * Span attributes that may leave the process. Everything else is
 * dropped by `AllowlistSpanExporter` before export and redacted again by the
 * Collector. Absent by design: `url.full`, `url.path`, `url.query`,
 * `db.query.text`, exception messages, request and response bodies.
 */
export const SPAN_ATTRIBUTE_ALLOWLIST: ReadonlySet<string> = new Set([
  // actor and request
  'user.id',
  'app.actor.kind',
  'app.job',
  'app.request.id',
  'app.workspace.id',
  // http, without URLs
  'http.request.method',
  'http.response.status_code',
  'http.route',
  'server.address',
  'server.port',
  'network.protocol.version',
  // database, without statements
  'db.system.name',
  'db.operation.name',
  'db.namespace',
  // errors as codes and hashes only
  'error.type',
  'app.error.code',
  'app.error.hash',
  // model calls (design §15)
  'gen_ai.conversation.id',
  'gen_ai.provider.name',
  'gen_ai.request.model',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  // gateway and scope decisions
  'app.policy.decision',
  'app.policy.rule',
  'app.scope.label',
  'app.scope.stage',
  'app.scope.rule_id',
  // Security events as span events, and log records (app/security/telemetry/log_records.ts).
  'app.security.event',
  'app.security.severity',
  'app.repository.id',
  'app.ingest.ref',
  'app.ingest.trigger',
  // Metric attributes (app/security/telemetry/metrics.ts).
  'app.ingest.state',
  'app.ingest.step',
  'app.run.state',
  'app.gate.released',
  'app.gate.mechanism',
])
