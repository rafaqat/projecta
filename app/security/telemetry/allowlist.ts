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
  'app.error.cause',
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
  // The turn's own spans (app/security/telemetry/spans.ts). Counts, labels and statuses: the shape
  // of a turn, never its text. Content rides only under the developer flag (debug_content.ts) and
  // is deliberately absent from this list.
  'app.turn.run_handle',
  'app.turn.commit',
  'app.turn.scope_label',
  'app.turn.run_state',
  'app.turn.reason',
  'app.turn.released',
  'app.turn.citations',
  'app.turn.withheld_count',
  'app.retrieval.seed_source',
  'app.retrieval.status',
  'app.retrieval.seeds',
  'app.retrieval.seeds',
  'app.retrieval.items',
  'app.retrieval.chunks',
  'app.retrieval.lexical_backend',
  'app.agent.round',
  'app.agent.tools_requested',
  'app.agent.stop_reason',
  'app.agent.iterations',
  'app.tool.name',
  'app.tool.status',
  'app.model.id',
  'app.model.input_tokens',
  'app.model.output_tokens',
  'app.model.cache_read_tokens',
  'app.model.cache_creation_tokens',
  'app.gate.mechanism',
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
