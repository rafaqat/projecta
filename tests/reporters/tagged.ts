import { appendFileSync } from 'node:fs'
import type { NamedReporterContract } from '@japa/runner/types'

/**
 * Emits one JSON line per finished test, including its tags. The built-in
 * ndjson reporter omits tags, and `node ace verify` needs them to map tests
 * back to acceptance criteria. When TAGGED_REPORT_PATH is set the lines are
 * appended to that file synchronously: the runner force-exits at the end,
 * and a piped stdout can lose its last buffered lines on exit.
 */
export const taggedReporter: NamedReporterContract = {
  name: 'tagged',
  handler(_runner, emitter) {
    const path = process.env.TAGGED_REPORT_PATH
    const emit = (line: string) => (path ? appendFileSync(path, line + '\n') : console.log(line))
    // A start line on stderr as well: with buffered or cut-off output, the last start
    // without an end names the test a timeout was in.
    emitter.on('test:start', (payload) => {
      process.stderr.write(`  ▶ ${payload.title.expanded}\n`)
    })
    emitter.on('test:end', (payload) => {
      emit(
        JSON.stringify({
          event: 'test:end',
          title: payload.title.expanded,
          tags: payload.tags,
          hasError: payload.hasError,
          skipped: payload.isSkipped === true,
          skipReason: payload.skipReason ?? null,
          errors: payload.errors.map((e) => String(e.error?.message ?? e.error).slice(-2000)),
        })
      )
    })
  },
}
