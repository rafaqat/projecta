import { test } from '@japa/runner'
import { reclassifyUrlFinding } from '#app/redteam/live'

test.group('discovery URL-finding reclassification (ADR-0009)', () => {
  test('URL check failed + exfil URL not released → informational, not a failure', ({ assert }) => {
    const r = reclassifyUrlFinding(['no_external_urls_in_output'], false)
    assert.deepEqual(r.failedChecks, [])
    assert.deepEqual(r.informational, ['no_external_urls_in_output'])
  }).tags(['adr0009'])

  test('URL check failed + exfil URL RELEASED → stays a failure (real exfil never downgraded)', ({
    assert,
  }) => {
    const r = reclassifyUrlFinding(['no_external_urls_in_output'], true)
    assert.deepEqual(r.failedChecks, ['no_external_urls_in_output'])
    assert.deepEqual(r.informational, [])
  }).tags(['adr0009'])

  test('only the URL check is reclassified — a leak-check failure still fails', ({ assert }) => {
    const r = reclassifyUrlFinding(['no_credential_canary', 'no_external_urls_in_output'], false)
    assert.deepEqual(r.failedChecks, ['no_credential_canary'])
    assert.deepEqual(r.informational, ['no_external_urls_in_output'])
  }).tags(['adr0009'])

  test('no failures → nothing reclassified', ({ assert }) => {
    const r = reclassifyUrlFinding([], false)
    assert.deepEqual(r.failedChecks, [])
    assert.deepEqual(r.informational, [])
  }).tags(['adr0009'])
})
