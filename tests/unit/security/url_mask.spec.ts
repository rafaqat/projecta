import { test } from '@japa/runner'
import { URL_MASK_TOKEN, maskExternalUrls, urlRule, PolicyViolation } from '#guards/output_rules'

/** Blanket policy (ADR-0007): no allowlisted hosts — every external link is masked. */
const blanket = () => urlRule([])

test.group('external URL masking (ADR-0007)', () => {
  test('masks an external URL to the token', ({ assert }) => {
    const { text, masked } = maskExternalUrls('See https://evil.example/exfil?d=1 for more.')
    assert.equal(masked, 1)
    assert.notInclude(text, 'evil.example')
    assert.include(text, URL_MASK_TOKEN)
  }).tags(['adr0007'])

  test('blanket policy masks even a well-known host (urls are not shown)', ({ assert }) => {
    const { text, masked } = maskExternalUrls('Docs at https://github.com/foo/bar here.')
    assert.equal(masked, 1)
    assert.notInclude(text, 'github.com')
  }).tags(['adr0007'])

  test('keeps identifier / origin hosts in place (they carry nothing out)', ({ assert }) => {
    const src =
      'xmlns="http://www.w3.org/2000/svg" and http://localhost:3000 and http://example.com'
    const { text, masked } = maskExternalUrls(src)
    assert.equal(masked, 0)
    assert.equal(text, src)
  }).tags(['adr0007'])

  test('masks a markdown image (a fetch vector) whole', ({ assert }) => {
    const { text, masked } = maskExternalUrls('![tracker](https://evil.example/p.png)')
    assert.equal(masked, 1)
    assert.notInclude(text, 'evil.example')
    assert.notInclude(text, '![')
  }).tags(['adr0007'])

  test('leaves text without links untouched', ({ assert }) => {
    const { text, masked } = maskExternalUrls('refundPayment handles refunds; see PaymentService.')
    assert.equal(masked, 0)
    assert.equal(text, 'refundPayment handles refunds; see PaymentService.')
  }).tags(['adr0007'])

  test('the fail-closed guarantee: assert passes on masked output', ({ assert }) => {
    const rule = blanket()
    const { text } = rule.mask!('leak https://evil.example/x and ![i](https://evil.example/y.png)')
    // After masking, re-asserting must find nothing — anything mask missed would still throw.
    assert.doesNotThrow(() => rule.assert(text))
  }).tags(['adr0007'])

  test('an external URL still throws when only asserted (unmasked path unchanged)', ({
    assert,
  }) => {
    assert.throws(() => blanket().assert('see https://evil.example/x'), PolicyViolation)
  }).tags(['adr0007'])
})
