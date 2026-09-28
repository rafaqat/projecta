import { test } from '@japa/runner'
import {
  capFor,
  contentTelemetryEnabled,
  contentValue,
  CONTENT_ATTRIBUTES,
  CONTENT_ATTRIBUTE_CAPS,
} from '#app/security/telemetry/debug_content'
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

/**
 * The caps are per attribute because the attributes are not alike, and the first version used one
 * number for all of them: 2 KB, which clipped evidence packs silently. Nothing here is a platform
 * limit (the SDK's own value-length limit defaults to Infinity); the caps guard repetition.
 */
test.group('content attribute caps', () => {
  test('a long value is truncated to its own cap and says how much was cut', ({ assert }) => {
    const paths = 'p'.repeat(20_000)
    const seeds = 's'.repeat(20_000)

    const cutPaths = contentValue('app.evidence.paths', paths)
    const cutSeeds = contentValue('app.seed.names', seeds)

    // Tempo truncates an attribute at 2048 bytes and says nothing, so the effective cap is the
    // backend's ceiling until a deployment raises it; the marker is then ours rather than absent.
    assert.equal(capFor('app.evidence.paths'), 2_000)
    assert.include(cutPaths, '[truncated 18000]')
    assert.include(cutSeeds, '[truncated 18000]')

    // A deployment whose Tempo carries more gets the attribute's own cap.
    const raised = { OTEL_ATTRIBUTE_CEILING_BYTES: '524288' }
    assert.equal(capFor('app.evidence.paths', raised), 16_384)
    assert.equal(capFor('app.seed.names', raised), 2_048)
    assert.equal(capFor('app.model.messages', raised), 262_144)
  })

  test('every declared content attribute has a cap, and only those are content', ({ assert }) => {
    for (const key of CONTENT_ATTRIBUTES) assert.isNumber(CONTENT_ATTRIBUTE_CAPS[key])
    assert.deepEqual([...CONTENT_ATTRIBUTES].sort(), Object.keys(CONTENT_ATTRIBUTE_CAPS).sort())
    // An undeclared key falls to the floor rather than being exported unbounded; the backend's
    // ceiling then applies to it like any other.
    assert.equal(capFor('app.turn.not_declared'), 2_000)
    assert.equal(capFor('app.turn.not_declared', { OTEL_ATTRIBUTE_CEILING_BYTES: '524288' }), 2_048)
  })
})
