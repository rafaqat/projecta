import logger from '@adonisjs/core/services/logger'
import { SecurityEventEmitter, type SecurityEventRecord } from '#app/security/events/emitter'

/**
 * Application-wide security event emitter. In this slice the sink is the structured log; the
 * OpenTelemetry span/metric sinks are wired back when the telemetry slice lands.
 */
function publish(record: SecurityEventRecord) {
  logger.warn({ securityEvent: record }, record.event)
}

export const securityEvents = new SecurityEventEmitter(publish)
