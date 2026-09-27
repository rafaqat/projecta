import { metrics, type Attributes } from '@opentelemetry/api'

/**
 * Runtime metrics. Counted by low-cardinality attributes
 * from this allowlist only, never by user or workspace: per-user review
 * belongs to decision records, and a workspace label would grow without
 * bound. The collector's redaction processor is the second stage. HTTP RED
 * metrics come from the auto-instrumentation; these are the application's own.
 */
export const METRIC_ATTRIBUTE_ALLOWLIST: ReadonlySet<string> = new Set([
  'app.ingest.state',
  'app.ingest.trigger',
  'app.ingest.step',
  'app.scope.label',
  'app.run.state',
  'app.gate.released',
  'app.gate.mechanism',
  'app.security.event',
  'app.security.severity',
  'app.job',
  // The C routine that raised a lexical index fault: a small fixed set of function names.
  'app.lexical.routine',
])

const meter = () => metrics.getMeter('code-intelligence-assistant')

/** Drops any attribute not on the allowlist before it reaches an instrument. */
function allowlisted(attributes: Attributes): Attributes {
  const out: Attributes = {}
  for (const [key, value] of Object.entries(attributes))
    if (METRIC_ATTRIBUTE_ALLOWLIST.has(key) && value !== undefined) out[key] = value
  return out
}

export const appMetrics = {
  /** One ingest job ended, finished or failed (a retry counts again when it ends). */
  ingestJob(state: 'finished' | 'failed', trigger: string) {
    meter()
      .createCounter('app.ingest.jobs', { description: 'Ingest jobs ended, by outcome' })
      .add(1, allowlisted({ 'app.ingest.state': state, 'app.ingest.trigger': trigger }))
  },

  /** How long one ingest step took, in seconds. */
  ingestStep(step: string, milliseconds: number) {
    meter()
      .createHistogram('app.ingest.step.duration', {
        description: 'Ingest step duration',
        unit: 's',
      })
      .record(milliseconds / 1000, allowlisted({ 'app.ingest.step': step }))
  },

  /** One answer turn ended: how it was routed, how it ended, whether text was released. */
  turn(outcome: { scopeLabel: string; runState: string; released: boolean }) {
    meter()
      .createCounter('app.turns', { description: 'Answer turns ended, by scope label and state' })
      .add(
        1,
        allowlisted({
          'app.scope.label': outcome.scopeLabel,
          'app.run.state': outcome.runState,
          'app.gate.released': outcome.released,
        })
      )
  },

  /** The evidence gate withheld text, by mechanism (no_citation, budget, error...). */
  withheld(mechanism: string) {
    meter()
      .createCounter('app.gate.withheld', { description: 'Turns withheld by the evidence gate' })
      .add(1, allowlisted({ 'app.gate.mechanism': mechanism }))
  },

  /**
   * A BM25 index fault sent one lexical query to the tsvector fallback. Counted because the
   * fallback is silent by design: without this, the rate at which retrieval degrades is
   * unmeasurable, and a warning line is the only trace (2026-09-27: 52 per CI run, unnoticed).
   */
  lexicalFault(routine: string) {
    meter()
      .createCounter('app.lexical.faults', {
        description:
          'Lexical queries degraded to the tsvector fallback, by the routine that raised',
      })
      .add(1, allowlisted({ 'app.lexical.routine': routine }))
  },

  /** One security event from the catalogue was emitted. */
  securityEvent(event: string, severity: string) {
    meter()
      .createCounter('app.security.events', { description: 'Security events, by event' })
      .add(1, allowlisted({ 'app.security.event': event, 'app.security.severity': severity }))
  },
}
