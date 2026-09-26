import { test } from '@japa/runner'
import { createHash } from 'node:crypto'
import {
  isShareFormat,
  newShareToken,
  SHARE_TTL_MS,
  shareTokenHash,
} from '#app/dependencies/share_links'
import { RateWindow } from '#app/security/rate_window'

/**: the token, its hash, the fixed lifetime, and the limit on the public route. */
test.group('BOM share tokens', () => {
  test('a token is 256 random bits, and only its SHA-256 is ever looked up', ({ assert }) => {
    const { token, hash } = newShareToken()
    assert.match(token, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(Buffer.from(token, 'base64url').length, 32)
    assert.equal(hash, createHash('sha256').update(token).digest('hex'))
    assert.equal(shareTokenHash(token), hash)
    assert.notEqual(newShareToken().token, token, 'fresh each time')
  }).tags(['AC-WP23-06', 'wp23'])

  test('anything not shaped like a token never reaches a lookup', ({ assert }) => {
    for (const bad of [
      '',
      'x',
      '../../etc/passwd',
      'a'.repeat(42),
      'a'.repeat(44),
      `${'a'.repeat(42)}=`,
      42,
      null,
    ])
      assert.isNull(shareTokenHash(bad), String(bad))
  }).tags(['AC-WP23-06', 'wp23'])

  test('a link lives fifteen minutes, fixed, and opens only the two formats', ({ assert }) => {
    assert.equal(SHARE_TTL_MS, 15 * 60 * 1000)
    assert.isTrue(isShareFormat('spdx') && isShareFormat('cyclonedx'))
    assert.isFalse(isShareFormat('xml') || isShareFormat(undefined))
  }).tags(['AC-WP23-02', 'wp23'])
})

test.group('rate window', () => {
  test('allows up to the limit in the window, refuses beyond it, and recovers when the window moves', ({
    assert,
  }) => {
    let now = 0
    const limit = new RateWindow(3, 1000, () => now)
    assert.deepEqual(
      [1, 2, 3, 4].map(() => limit.allow('k')),
      [true, true, true, false]
    )
    assert.isTrue(limit.allow('other'), 'keys are independent')
    now = 1000
    assert.isTrue(limit.allow('k'), 'the window slid')
  }).tags(['AC-WP23-01', 'wp23'])
})
