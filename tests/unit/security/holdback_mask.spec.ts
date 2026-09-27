import { test } from '@japa/runner'
import { HoldbackStream, type Frame } from '#guards/holdback'
import { urlRule, secretRule, URL_MASK_TOKEN } from '#guards/output_rules'

/** A text_delta SSE frame carrying `text`. */
const t = (text: string): Frame => ({
  raw: `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`,
  text,
})
/** A control (non-text) SSE frame. */
const c = (raw: string): Frame => ({ raw: `${raw}\n\n`, text: '' })

test.group('HoldbackStream buffered masking (ADR-0007)', () => {
  test('mask mode buffers: push releases nothing until end()', async ({ assert }) => {
    const h = new HoldbackStream([urlRule([])], 128, true, true)
    assert.isTrue(h.maskMode)
    const released = await h.push([t('hello '), t('world')])
    assert.equal(released, '')
  })

  test('masks a URL split across frames (the boundary leak) instead of releasing it', async ({
    assert,
  }) => {
    const h = new HoldbackStream([urlRule([])], 128, true, true)
    await h.push([t('see https://ev'), t('il.example/x now')])
    const out = await h.end()
    assert.notInclude(out, 'evil.example')
    assert.include(out, URL_MASK_TOKEN)
    assert.equal(h.masked, 1)
    assert.isNull(h.violation)
  })

  test('passes control frames through and re-emits masked text once', async ({ assert }) => {
    const start = c('event: message_start\ndata: {"type":"message_start"}')
    const stop = c('event: message_stop\ndata: {"type":"message_stop"}')
    const h = new HoldbackStream([urlRule([])], 128, true, true)
    await h.push([start, t('go to https://evil.example/a'), stop])
    const out = await h.end()
    assert.include(out, 'message_start')
    assert.include(out, 'message_stop')
    assert.include(out, URL_MASK_TOKEN)
    assert.notInclude(out, 'evil.example')
  })

  test('a secret in the buffered answer still withholds (fail-closed), even with a mask rule', async ({
    assert,
  }) => {
    const h = new HoldbackStream([urlRule([]), secretRule()], 128, true, true)
    await h.push([t('the key is AKIA'), t('ABCDEFGHIJKLMNOP and a link https://evil.example/x')])
    const out = await h.end()
    assert.equal(out, '')
    assert.isNotNull(h.violation)
    assert.equal(h.masked, 0)
  })

  test('leaves a link-free answer intact', async ({ assert }) => {
    const h = new HoldbackStream([urlRule([])], 128, true, true)
    await h.push([t('refundPayment handles refunds.')])
    const out = await h.end()
    assert.include(out, 'refundPayment handles refunds.')
    assert.equal(h.masked, 0)
  })

  test('mask is OFF by default: the structural harness still withholds a URL (no opt-in)', async ({
    assert,
  }) => {
    const h = new HoldbackStream([urlRule([])]) // no enableMask flag
    assert.isFalse(h.maskMode)
    await h.push([t('go to https://evil.example/a')])
    const out = await h.end()
    assert.equal(out, '') // withheld, not masked
    assert.isNotNull(h.violation)
  })
})
