import { test } from '@japa/runner'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startProfiling } from '#app/security/telemetry/profiling'

/**
 * Profiles leave the process without passing the Collector (ADR-0024), which is only defensible
 * while a profile is symbols. `wrapWithLabels` is the one API in `@pyroscope/nodejs` that attaches
 * arbitrary key-value pairs to samples, so it is the one place request content could reach a
 * profile. This asserts the application does not call it: the decision is enforced rather than
 * remembered.
 */
const ROOTS = ['app', 'config', 'commands', 'services', 'start']

async function* sourceFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(path)
    else if (entry.name.endsWith('.ts')) yield path
  }
}

test.group('profiles carry symbols, not data', () => {
  test('the application never attaches labels to samples', async ({ assert }) => {
    const offenders: string[] = []
    for (const root of ROOTS)
      for await (const file of sourceFiles(root)) {
        const source = await readFile(file, 'utf8')
        if (source.includes('wrapWithLabels')) offenders.push(file)
      }

    assert.deepEqual(
      offenders,
      [],
      `wrapWithLabels can put request content in a profile (ADR-0024)`
    )
  })

  test('profiling is off unless a server address is set', ({ assert }) => {
    assert.isFalse(startProfiling({ APP_ENV: 'production' }))
    assert.isFalse(startProfiling({ APP_ENV: 'local', PYROSCOPE_SERVER_ADDRESS: '' }))
  })
})
