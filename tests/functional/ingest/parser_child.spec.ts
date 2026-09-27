import { test } from '@japa/runner'
import { ParserChild } from '#app/parse/child_process'

test.group('parser child process (SEC-01)', () => {
  test('the child sees no secret from the worker environment', async ({ assert }) => {
    process.env.INGEST_CANARY = 'WORKER-ENV-CANARY-child'
    const child = new ParserChild(new URL('../../../app/parse/child.ts', import.meta.url).pathname)
    try {
      const pong = await child.request({ type: 'ping' })
      assert.equal(pong.type, 'pong')
      const env = pong.env as string[]
      for (const forbidden of [
        'APP_KEY',
        'DB_PASSWORD',
        'LLM_GATEWAY_TOKEN',
        'OIDC_CLIENT_SECRET',
        'INGEST_CANARY',
        'HOME',
      ]) {
        assert.notInclude(env, forbidden)
      }
      assert.include(env, 'PATH')
    } finally {
      child.close()
      delete process.env.INGEST_CANARY
    }
  }).tags(['AC-WP03-01', 'wp03'])

  test('a child that cannot start names why, instead of waiting out the timeout', async ({
    assert,
  }) => {
    const absent = new URL('../../../app/parse/no_such_child.ts', import.meta.url).pathname
    const child = new ParserChild(absent)
    const started = Date.now()
    try {
      await assert.rejects(
        () => child.request({ type: 'ping' }, 20_000),
        /parser child (exited with code|was killed by|could not be started)/
      )
      // The reason arrives when the child dies, not when the request gives up waiting for it.
      assert.isBelow(Date.now() - started, 10_000)
    } finally {
      child.close()
    }
  }).tags(['AC-WP03-01', 'wp03'])
})
