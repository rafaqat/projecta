import { test } from '@japa/runner'
import { securityEvents } from '#app/security/events/index'
import { SECURITY_EVENT_CATALOGUE } from '#app/security/events/catalogue'
import { type SecurityEventRecord } from '#app/security/events/emitter'

/**
 * Content the egress/inbound guards clean or reject is surfaced as catalogued security events so a
 * spike is alertable (each event is a log record AND an `app.security.events` counter). The catalogue
 * caps the fields, so request content (a masked URL's path/query, a redacted secret) can never ride
 * along into logs or telemetry — only counts, an id, and (for a solicited fetch) the bare host.
 */
test.group('security events · content cleanup/rejection', () => {
  test('the content events are catalogued', ({ assert }) => {
    for (const e of [
      'content.url_masked',
      'content.pii_masked',
      'question.url_requested',
      'answer.claim_withheld',
    ] as const)
      assert.exists(SECURITY_EVENT_CATALOGUE[e], `${e} is catalogued`)
    // The solicited-fetch event carries the host only — never a path or query.
    assert.deepEqual([...SECURITY_EVENT_CATALOGUE['question.url_requested'].fields].sort(), [
      'host',
      'requestId',
    ])
    assert.deepEqual([...SECURITY_EVENT_CATALOGUE['content.url_masked'].fields].sort(), [
      'count',
      'requestId',
      'turnId',
    ])
  }).tags(['security', 'observability'])

  test('emit keeps only catalogued fields — content cannot ride along', ({ assert }) => {
    const seen: SecurityEventRecord[] = []
    const off = securityEvents.tap((r) => seen.push(r))
    try {
      // A caller tries to smuggle the payload alongside the host; only declared fields survive.
      securityEvents.emit('question.url_requested', {
        host: 'evil.example',
        requestId: 'r-1',
        path: '/steal?d=SECRET',
      } as Parameters<typeof securityEvents.emit>[1])
    } finally {
      off()
    }
    assert.lengthOf(seen, 1)
    assert.equal(seen[0].event, 'question.url_requested')
    assert.equal(seen[0].severity, 'warning')
    assert.equal(seen[0].fields.host, 'evil.example')
    assert.equal(seen[0].fields.requestId, 'r-1')
    assert.notProperty(seen[0].fields, 'path') // undeclared field dropped by the catalogue
  }).tags(['security', 'observability'])
})
