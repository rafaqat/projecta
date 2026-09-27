import { defineConfig } from '@adonisjs/otel'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import env from '#start/env'
import { ActorSpanProcessor } from '#app/security/telemetry/actor_span_processor'
import { AllowlistSpanExporter } from '#app/security/telemetry/allowlist_span_exporter'
import { AllowlistLogRecordExporter } from '#app/security/telemetry/log_records'

/**
 * Telemetry. Traces, logs and metrics leave the process, every span is stamped
 * with its actor, and attributes are reduced to the allowlist before the
 * OTLP exporter sees them. The Collector redacts again.
 */
const endpoint = env.get('OTEL_EXPORTER_OTLP_ENDPOINT')

export default defineConfig({
  enabled: endpoint !== undefined,
  serviceName: env.get('APP_NAME'),
  serviceVersion: env.get('APP_VERSION'),
  environment: env.get('APP_ENV'),
  userContext: false,
  spanProcessors: [
    new ActorSpanProcessor(),
    new BatchSpanProcessor(
      new AllowlistSpanExporter(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }))
    ),
  ],
  // Logs: pino records reach the collector through the OpenTelemetry bridge with
  // their attributes reduced to the allowlist, so a security event or an unhandled error is
  // found in Loki beside its trace. Stdout keeps the full line.
  // Metrics: HTTP RED metrics from the auto-instrumentation and the
  // application's own counters (app/security/telemetry/metrics.ts), attributes from the
  // allowlist, never per user.
  metricReaders: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 15_000,
    }),
  ],
  logRecordProcessors: [
    new BatchLogRecordProcessor({
      exporter: new AllowlistLogRecordExporter(new OTLPLogExporter({ url: `${endpoint}/v1/logs` })),
    }),
  ],
  instrumentations: {
    // Statement capture stays off: queries would carry repository content.
    '@opentelemetry/instrumentation-pg': { enhancedDatabaseReporting: false },
    // Log records leave through the allowlist exporter below with the trace context attached;
    // exception text is replaced by type, code and hash.
    '@opentelemetry/instrumentation-pino': { disableLogCorrelation: false },
    '@opentelemetry/instrumentation-fs': { enabled: false },
    '@opentelemetry/instrumentation-dns': { enabled: false },
    '@opentelemetry/instrumentation-net': { enabled: false },
  },
})
