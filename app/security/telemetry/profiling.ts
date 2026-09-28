import { createHash } from 'node:crypto'
import Pyroscope from '@pyroscope/nodejs'

/**
 * Continuous profiling (ADR-023). Traces say a round took twelve seconds; a profile says whether
 * that was the provider, the parser or the evidence gate.
 *
 * What leaves the process is stack traces: function names, file paths and line numbers from this
 * application and its dependencies, sampled on a timer. No request content, no arguments, no
 * repository text. It is worth stating plainly that this path does not pass the Collector, so the
 * span and log allowlists do not apply to it: a profile is symbols, and symbols are the binary, not
 * the data. The allowlists exist because a span attribute could hold a question; a stack frame
 * cannot.
 *
 * Off unless `PYROSCOPE_SERVER_ADDRESS` is set, like the OTLP endpoint. Starting it is best effort:
 * a profiler that cannot reach its server must not stop the application from booting, so the
 * failure is reported and the process continues without profiles.
 */

/** The boot path runs before the container's logger exists, so the report goes to stderr as JSON. */
function reportProfilingFailure(stage: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(
    `${JSON.stringify({
      level: 40,
      name: 'projectA',
      errorCode: 'E_PROFILER_UNAVAILABLE',
      errorHash: createHash('sha256').update(message).digest('hex').slice(0, 16),
      errorName: error instanceof Error ? error.name : 'Error',
      stage,
      msg: 'continuous profiling did not start',
    })}\n`
  )
}

export function startProfiling(env: NodeJS.ProcessEnv = process.env): boolean {
  const serverAddress = env.PYROSCOPE_SERVER_ADDRESS
  if (!serverAddress) return false
  try {
    Pyroscope.init({
      serverAddress,
      appName: env.APP_NAME ?? 'projectA',
      // Low cardinality only, the same rule the metric attributes follow: never a user, never a
      // workspace. A profile series per tenant would grow without bound and would say who was
      // working, which is not what a flame graph is for.
      tags: {
        service_version: env.APP_VERSION ?? '0.0.0',
        environment: env.APP_ENV ?? 'local',
        role: env.PYROSCOPE_ROLE ?? 'web',
      },
    })
    Pyroscope.start()
    return true
  } catch (error) {
    reportProfilingFailure('start', error)
    return false
  }
}
