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
  // model calls (design §15). Written on the round span by the agent; the counts arrive from the SDK
  // adapter through `onUsage`, because they exist nowhere else (INV-01). `gen_ai.provider.name` used
  // to sit here and was removed: provider selection belongs to the gateway's route table, so the
  // application cannot write it, and a key nothing can write is a claim the allowlist cannot keep.
  'gen_ai.conversation.id',
  'gen_ai.request.model',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  // Reported separately from `input_tokens` rather than inside it, so a cached round shows a small
  // input count and these say why instead of it reading as a shrunken prompt.
  'gen_ai.usage.cache_read_input_tokens',
  'gen_ai.usage.cache_creation_input_tokens',
  // Whether the counts above are the whole story. A round that failed mid-stream knows its input
  // tokens and never learned its output, and an absent count is otherwise indistinguishable from a
  // free one once a panel sums it.
  'gen_ai.usage.complete',
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
  'app.retrieval.items',
  'app.retrieval.chunks',
  'app.agent.round',
  'app.agent.tools_requested',
  'app.agent.stop_reason',
  'app.agent.iterations',
  'app.tool.name',
  'app.tool.status',
  // Which system prompt produced the answer: the file's id, its version and the head of its
  // sha256, which configHash already covers. Identifies the text without carrying it.
  'app.model.system_prompt',
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
])
