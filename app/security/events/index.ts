import logger from '@adonisjs/core/services/logger'
import { appMetrics } from '#app/security/telemetry/metrics'
import { SecurityEventEmitter, type SecurityEventRecord } from '#app/security/events/emitter'

/**
 * Application-wide security event emitter. Each event is both a structured log record (exported to the
 * collector through the allowlist exporter, trace-correlated) AND a counter metric
 * (`app.security.events`, by event + severity), so a rejection or cleanup is alertable and
 * dashboardable, not only searchable after the fact. The catalogue caps the fields either sink sees.
 */
function publish(record: SecurityEventRecord) {
  logger.warn({ securityEvent: record }, record.event)
  appMetrics.securityEvent(record.event, record.severity)
}

export const securityEvents = new SecurityEventEmitter(publish)
