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
})
