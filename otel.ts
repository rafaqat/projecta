/**
 * OpenTelemetry initialization file.
 *
 * IMPORTANT: This file must be imported FIRST in bin/server.ts
 * for auto-instrumentation to work correctly.
 */
import { init } from '@adonisjs/otel/init'
import { startProfiling } from '#app/security/telemetry/profiling'

await init(import.meta.dirname)

// Profiles go straight to Pyroscope rather than through the Collector (profiling.ts explains why
// the allowlists do not apply). Started here so the profiler is running before the first request.
startProfiling()
