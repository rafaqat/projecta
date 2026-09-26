import {
  SECURITY_EVENT_CATALOGUE,
  type SecurityEventFields,
  type SecurityEventName,
  type Severity,
} from '#app/security/events/catalogue'
import { currentActor, type Actor } from '#app/security/telemetry/actor_scope'

export interface SecurityEventRecord {
  event: SecurityEventName
  severity: Severity
  at: string
  actor: Actor | { kind: 'anonymous' }
  fields: Record<string, string | number>
}

export type SecurityEventSink = (record: SecurityEventRecord) => void

/**
 * Emits catalogued security events. Unknown events throw and undeclared
 * fields are dropped, so request content cannot ride along by accident.
 */
export class SecurityEventEmitter {
  private readonly listeners = new Set<SecurityEventSink>()

  constructor(private readonly sink: SecurityEventSink) {}

  /** Observes emissions (tests, alert rules). Returns an unsubscribe function. */
  tap(listener: SecurityEventSink): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit<N extends SecurityEventName>(event: N, fields: SecurityEventFields<N>): SecurityEventRecord {
    const entry = SECURITY_EVENT_CATALOGUE[event]
    if (!entry) throw new Error(`security event ${String(event)} is not in the catalogue`)

    const allowed = new Set<string>(entry.fields)
    const kept: Record<string, string | number> = {}
    for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
      if (allowed.has(key) && (typeof value === 'string' || typeof value === 'number')) {
        kept[key] = value
      }
    }
    const record: SecurityEventRecord = {
      event,
      severity: entry.severity,
      at: new Date().toISOString(),
      actor: currentActor() ?? { kind: 'anonymous' },
      fields: kept,
    }
    this.sink(record)
    for (const listener of this.listeners) listener(record)
    return record
  }
}
