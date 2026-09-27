import { test } from '@japa/runner'
import { gatewayEventTap, type GatewayEvent } from '#tests/helpers/gateway/tap'
import {
  call,
  canonicalBody,
  keys,
  policyFor,
  recordingProvider,
  startGateway,
} from '#tests/helpers/gateway/harness'

/**
 * The gateway runs as its own process (and, under test, its own harness instance with a per-test
 * `events` array) — it has no ambient security-event emitter to tap, by design. This shared tap is the
 * one opt-in fan-out that lets the red-team CI reporter collect gateway-side events (policy.enforced,
 * injection.suspected, honeytoken.foreign) into the same per-test artifact as the app-side events,
 * without changing what a test asserts on its own `gw.events`. With no listeners it is a no-op.
 */
test.group('gateway event tap', () => {
  test('a tapped listener receives emitted gateway events', ({ assert }) => {
    const seen: GatewayEvent[] = []
    const off = gatewayEventTap.tap((e) => seen.push(e))
    gatewayEventTap.emit({
      event: 'policy.enforced',
      fields: { rule: 'allowlist.host', decision: 'reject' },
    })
    off()
    assert.lengthOf(seen, 1)
    assert.equal(seen[0].event, 'policy.enforced')
  })

  test('unsubscribe stops delivery and no listeners is a no-op', ({ assert }) => {
    const seen: GatewayEvent[] = []
    const off = gatewayEventTap.tap((e) => seen.push(e))
    off()
    // No throw with nothing tapped, and the unsubscribed listener sees nothing.
    gatewayEventTap.emit({ event: 'injection.suspected', fields: { detector: 'rules-v1' } })
    assert.lengthOf(seen, 0)
  })

  test('a throwing listener never breaks the others', ({ assert }) => {
    const seen: GatewayEvent[] = []
    const offBad = gatewayEventTap.tap(() => {
      throw new Error('reporter fault')
    })
    const offGood = gatewayEventTap.tap((e) => seen.push(e))
    gatewayEventTap.emit({ event: 'honeytoken.foreign', fields: { severity: 'P1' } })
    offBad()
    offGood()
    assert.lengthOf(seen, 1)
    assert.equal(seen[0].event, 'honeytoken.foreign')
  })

  // End-to-end proof that the harness actually fans out: a real gateway call that trips a policy
  // rejection must reach the shared tap (the path the CI reporter relies on), while `gw.events` — what
  // other tests assert on — still records it too. Missing x-attribution is rejected before any egress.
  test('a real gateway policy rejection reaches both the shared tap and gw.events', async ({
    assert,
  }) => {
    const seen: GatewayEvent[] = []
    const off = gatewayEventTap.tap((e) => seen.push(e))
    const provider = recordingProvider('')
    const upstream = await provider.listen()
    const k = keys()
    const gateway = await startGateway(policyFor(k), upstream)
    try {
      const body = canonicalBody()
      const r = await call(gateway, body, {}) // no x-attribution → attribution reject
      assert.notEqual(r.status, 200)
      const tapped = seen.find((e) => e.event === 'policy.enforced')
      assert.exists(tapped, 'policy.enforced reached the shared tap')
      assert.equal(tapped!.fields.decision, 'reject')
      assert.isTrue(String(tapped!.fields.rule).startsWith('attribution.'))
      assert.isTrue(
        gateway.events.some((e) => e.event === 'policy.enforced'),
        'gw.events still records it (per-test assertions unaffected)'
      )
    } finally {
      off()
      await gateway.close()
      provider.server.close()
    }
  })
})
