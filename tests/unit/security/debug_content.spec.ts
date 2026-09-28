import { test } from '@japa/runner'
import { contentTelemetryEnabled } from '#app/security/telemetry/debug_content'
import { evaluateBootGuards } from '#app/security/boot_guards'

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
