import { appendFileSync } from 'node:fs'
import type { NamedReporterContract } from '@japa/runner/types'
import { securityEvents } from '#app/security/events/index'
import { gatewayEventTap } from '#tests/helpers/gateway/tap'

/**
 * Correlates security events to the test that triggered them, from BOTH boundaries:
 *   - the application process (via `securityEvents`): question.url_requested, authz.denied, content.*
 *   - the gateway (via the harness's `gatewayEventTap`): policy.enforced, injection.suspected,
 *     honeytoken.foreign, canary.followed, detector.unavailable
 * Per test, it records every event that fired while it ran and appends one JSON line to
 * SECURITY_EVENTS_REPORT_PATH. The red-team CI lane sets that path and uploads the file, so a run
 * leaves a downloadable case -> events map, each event tagged with its `source`.
 *
 * Neither side carries request content: the app catalogue caps fields to ids/counts/host, and the
 * gateway only ever emits policy metadata (rule, decision, sub, workspace, detector, code — see the
 * emit sites in gateway.ts, e.g. injection.suspected: "Never the text."). As defence in depth we also
 * keep only primitive field values here, so no object could ride in through a future gateway emit.
 * Inert unless the path is set, and only activated then (tests/bootstrap.ts).
 */
interface RecordedEvent {
  source: 'app' | 'gateway'
  event: string
  severity: string
  fields: Record<string, string | number | boolean>
}

function primitives(fields: Record<string, unknown>): Record<string, string | number | boolean> {
  const kept: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(fields))
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      kept[key] = value
  return kept
}

/**
 * How a gateway event's severity is normalised for the artifact. The gateway has no catalogue, so we
 * prefer an explicit `severity` field when it emitted one (honeytoken.foreign P1, holdback block
 * critical, canary.followed watch), and otherwise mirror the gateway's own stdout split
 * (services/llm-gateway/src/server.ts): policy.enforced and honeytoken.foreign are warnings, the rest
 * informational. Adjust here if a run should treat, say, every injection.suspected as a warning.
 */
function gatewaySeverity(event: string, fields: Record<string, unknown>): string {
  if (typeof fields.severity === 'string') return fields.severity
  return event === 'policy.enforced' || event === 'honeytoken.foreign' ? 'warn' : 'info'
}

export const securityEventsReporter: NamedReporterContract = {
  name: 'security-events',
  handler(_runner, emitter) {
    const path = process.env.SECURITY_EVENTS_REPORT_PATH
    if (!path) return
    let current: string | null = null
    let collected: RecordedEvent[] = []
    // Two taps for the whole run; events are attributed to the test in flight when they fire.
    securityEvents.tap((record) => {
      if (current)
        collected.push({
          source: 'app',
          event: record.event,
          severity: record.severity,
          fields: record.fields,
        })
    })
    gatewayEventTap.tap((event) => {
      if (current)
        collected.push({
          source: 'gateway',
          event: event.event,
          severity: gatewaySeverity(event.event, event.fields),
          fields: primitives(event.fields),
        })
    })
    emitter.on('test:start', (payload) => {
      current = payload.title.expanded
      collected = []
    })
    emitter.on('test:end', (payload) => {
      if (collected.length)
        appendFileSync(
          path,
          JSON.stringify({
            test: payload.title.expanded,
            tags: payload.tags,
            events: collected,
          }) + '\n'
        )
      current = null
      collected = []
    })
  },
}
