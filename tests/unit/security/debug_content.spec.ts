import { test } from '@japa/runner'
import { contentTelemetryEnabled } from '#app/security/telemetry/debug_content'
import { evaluateBootGuards } from '#app/security/boot_guards'
import { exportedBodyOf } from '#app/security/telemetry/log_records'

/**
 * Content telemetry exists for debugging and security operations on a developer's own stack: the
 * question, the evidence and the tool arguments, which SEC-14 otherwise drops. It is two-key: the
 * flag must be set AND the environment must be a developer's, so a flag that escapes into uat or
 * production turns nothing on. The collector's own allowlist is the third key and is configured
 * separately, so no single mistake exports a prompt.
 */
const ON = { TELEMETRY_DEBUG_CONTENT: '1' }

test.group('contentTelemetryEnabled', () => {
  test('the flag alone does not enable it outside a developer environment', ({ assert }) => {
    assert.isTrue(contentTelemetryEnabled({ ...ON, APP_ENV: 'local' }))
    assert.isTrue(contentTelemetryEnabled({ ...ON, APP_ENV: 'test' }))
    assert.isFalse(contentTelemetryEnabled({ ...ON, APP_ENV: 'uat' }))
    assert.isFalse(contentTelemetryEnabled({ ...ON, APP_ENV: 'production' }))
    assert.isFalse(contentTelemetryEnabled({ ...ON, APP_ENV: undefined }))
  })
})

test.group('the boot guard refuses the flag outside a developer environment', () => {
  const base = {
    env: {} as Record<string, string | undefined>,
    allowedIssuers: ['https://issuer.example'],
    routes: [],
    bundledModules: [],
    testModules: [],
  }

  test('uat and production refuse to start; local and test do not', ({ assert }) => {
    for (const appEnv of ['uat', 'production']) {
      const result = evaluateBootGuards({
        ...base,
        appEnv,
        env: { ...ON, INJECTION_DETECTOR_MODEL: 'm', OIDC_ISSUER: 'https://issuer.example' },
      })
      assert.isFalse(result.ok, `${appEnv} should refuse`)
      assert.include(result.violations.join(' '), 'TELEMETRY_DEBUG_CONTENT')
    }
    const local = evaluateBootGuards({ ...base, appEnv: 'local', env: { ...ON } })
    assert.isTrue(local.ok, local.violations.join(' '))
  })
})

/**
 * The 160-byte body limit is what stops an exception message leaving inside a `msg`. Turn content
 * is the single named exception to it, and the exception has to stay single: this asserts an
 * ordinary record is still cut, that one carrying an exception is still reduced to type, code and
 * hash, and that only a record declaring `app.content.kind` keeps its whole body.
 */
test.group('the log body limit has exactly one exception', () => {
  test('content records keep their body; nothing else does', ({ assert }) => {
    const long = 'x'.repeat(5_000)
    const before = process.env.TELEMETRY_DEBUG_CONTENT
    const beforeEnv = process.env.APP_ENV
    process.env.TELEMETRY_DEBUG_CONTENT = '1'
    process.env.APP_ENV = 'local'
    try {
      assert.equal(exportedBodyOf({ 'app.content.kind': 'messages' }, long).length, 5_000)
      assert.equal(exportedBodyOf({}, long).length, 160)
      // An exception is described, never quoted, content flag or not.
      const described = exportedBodyOf({ err: { name: 'Error', code: 'E_X', message: long } }, long)
      assert.notInclude(described, 'xxxx')
      assert.include(described, 'E_X')
    } finally {
      if (before === undefined) delete process.env.TELEMETRY_DEBUG_CONTENT
      else process.env.TELEMETRY_DEBUG_CONTENT = before
      if (beforeEnv === undefined) delete process.env.APP_ENV
      else process.env.APP_ENV = beforeEnv
    }
  })

  test('a content record is cut like any other when the flag is off', ({ assert }) => {
    const before = process.env.TELEMETRY_DEBUG_CONTENT
    delete process.env.TELEMETRY_DEBUG_CONTENT
    try {
      assert.equal(
        exportedBodyOf({ 'app.content.kind': 'messages' }, 'x'.repeat(5_000)).length,
        160
      )
    } finally {
      if (before !== undefined) process.env.TELEMETRY_DEBUG_CONTENT = before
    }
  })
})
