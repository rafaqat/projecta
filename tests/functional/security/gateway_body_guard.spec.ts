import { test } from '@japa/runner'
import { createServer } from 'node:http'
import {
  call,
  canonicalBody,
  keys,
  listen,
  policyFor,
  startGateway,
  token,
} from '#tests/helpers/gateway/harness'

/**
 * Two gateway boundary properties the streaming path alone did not cover:
 *  - a NON-streaming upstream response is still run through the output rules before it reaches the
 *    reader, so a JSON body cannot smuggle a blocked URL, secret or honeytoken past the hold-back;
 *  - an oversized request body is refused with 413 before it is buffered, so a caller cannot exhaust
 *    the gateway's memory.
 */

/** An upstream that answers with a single non-streaming JSON body (never text/event-stream). */
function jsonProvider(text: string) {
  return createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ content: [{ type: 'text', text }] }))
  })
}

test.group('gateway body guard', () => {
  test('a non-streaming response carrying a blocked URL is withheld from the reader', async ({
    assert,
  }) => {
    // github.com is the only allowed host (policyFor); a link to another host trips urlRule.
    const provider = jsonProvider('See https://evil.example/leak for the key.')
    const upstream = await listen(provider)
    const k = keys()
    const gateway = await startGateway(policyFor(k), upstream)
    try {
      const body = canonicalBody()
      const r = await call(gateway, body, { 'x-attribution': await token(k, body) })
      // ADR-0007: an external URL in a non-streaming body is masked, not withheld. The link never
      // reaches the reader; the rest of the body is delivered with the URL redacted to the token.
      assert.notInclude(r.text, 'evil.example', 'the blocked URL never reaches the reader')
      assert.include(r.text, '[external link hidden]', 'the outbound URL rule masked the link')
    } finally {
      await gateway.close()
      provider.close()
    }
  }).tags(['AC-WP08-06', 'wp08'])

  test('a clean non-streaming response is forwarded intact', async ({ assert }) => {
    const provider = jsonProvider('Refunds go through refundPayment; nothing sensitive here.')
    const upstream = await listen(provider)
    const k = keys()
    const gateway = await startGateway(policyFor(k), upstream)
    try {
      const body = canonicalBody()
      const r = await call(gateway, body, { 'x-attribution': await token(k, body) })
      assert.include(r.text, 'refundPayment', 'a clean body passes through unchanged')
      const blocked = gateway.events.find(
        (e) => e.event === 'policy.enforced' && e.fields.decision === 'block'
      )
      assert.notExists(blocked, 'nothing was blocked')
    } finally {
      await gateway.close()
      provider.close()
    }
  }).tags(['AC-WP08-06', 'wp08'])

  test('a request body over the cap is refused with 413 before it is buffered', async ({
    assert,
  }) => {
    const provider = jsonProvider('unused')
    const upstream = await listen(provider)
    const k = keys()
    const gateway = await startGateway(policyFor(k), upstream, { maxBodyBytes: 256 })
    try {
      // canonicalBody serialises to well over 256 bytes; the 413 lands before attribution runs.
      const body = canonicalBody({ padding: 'x'.repeat(2000) })
      const r = await call(gateway, body, { 'x-attribution': await token(k, body) })
      assert.equal(r.status, 413)
      assert.include(r.text, 'request_too_large')
    } finally {
      await gateway.close()
      provider.close()
    }
  }).tags(['AC-WP08-06', 'wp08'])
})
