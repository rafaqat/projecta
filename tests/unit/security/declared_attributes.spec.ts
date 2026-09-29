import { test } from '@japa/runner'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SPAN_ATTRIBUTE_ALLOWLIST } from '#app/security/telemetry/allowlist'

/**
 * An allowlisted attribute that nothing writes is a lie in the allowlist.
 *
 * It reads as a capability the system has and a reader can look for, and it fails in exactly the
 * way ADR-0023 warns a missing entry fails: silently, because an attribute that is never set looks
 * identical to one that is filtered out. Ten keys had reached that state, each declared in two
 * allowlists and produced by nothing.
 *
 * So every `app.*` key the application declares must appear somewhere that could set it. The check
 * is textual rather than behavioural on purpose: it costs one directory walk, it runs without a
 * database, and the failure it prevents is a key that no test would otherwise mention.
 */
const ROOTS = ['app', 'config', 'commands', 'services', 'start', 'providers']

/** Declared by the pipeline itself rather than by application code, so nothing here writes them. */
const SET_BY_INSTRUMENTATION = new Set([
  'user.id',
  'app.actor.kind',
  'app.job',
  'app.request.id',
  'app.workspace.id',
  'http.request.method',
  'http.response.status_code',
  'http.route',
  'server.address',
  'server.port',
  'network.protocol.version',
  'db.system.name',
  'db.operation.name',
  'db.namespace',
  'error.type',
])

async function* sourceFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(path)
    else if (entry.name.endsWith('.ts')) yield path
  }
}

async function applicationSource(): Promise<string> {
  const parts: string[] = []
  for (const root of ROOTS)
    for await (const file of sourceFiles(root)) {
      // The allowlists themselves declare the keys; they are not producers of them.
      if (file.includes('telemetry/allowlist') || file.includes('telemetry/debug_content')) continue
      parts.push(await readFile(file, 'utf8'))
    }
  return parts.join('\n')
}

test.group('every declared attribute has a producer', () => {
  test('no span attribute is allowlisted and never written', async ({ assert }) => {
    const source = await applicationSource()
    // Every namespace, not just `app.`. The original filter was `app.`-only, and the two keys that
    // outlived that narrowing were `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`:
    // declared in both allowlists, written by nothing, and reported clean by this very test. A guard
    // whose domain is narrower than the thing it guards passes truthfully and proves nothing.
    const dead = [...SPAN_ATTRIBUTE_ALLOWLIST]
      .filter((key) => !SET_BY_INSTRUMENTATION.has(key))
      .filter((key) => !source.includes(`'${key}'`))

    assert.deepEqual(dead, [], 'allowlisted with nothing to write them')
  })
})
