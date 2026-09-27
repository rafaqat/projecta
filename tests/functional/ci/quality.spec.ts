import { test } from '@japa/runner'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

test.group('lint and type checks', (group) => {
  group.each.timeout(180_000)

  test('TypeScript strict mode is enabled for the server and the client', async ({ assert }) => {
    for (const file of ['tsconfig.json', 'inertia/tsconfig.json']) {
      const config = JSON.parse(await readFile(file, 'utf8')) as {
        compilerOptions?: { strict?: boolean }
      }
      assert.isTrue(config.compilerOptions?.strict, `${file} must set compilerOptions.strict`)
    }
  }).tags(['AC-WP00-05', 'wp00'])

  test('make lint and make typecheck pass', async ({ assert }) => {
    await assert.doesNotReject(() => run('npm', ['run', 'lint']))
    await assert.doesNotReject(() => run('npm', ['run', 'typecheck']))
  }).tags(['AC-WP00-05', 'wp00'])
})
