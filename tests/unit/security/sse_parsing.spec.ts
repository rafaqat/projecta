import { test } from '@japa/runner'
import { parseFrames, HoldbackStream } from '#guards/holdback'
import { PolicyViolation, type OutputRule } from '#guards/output_rules'

/**
 * The output guard scans a frame's extracted `text` but forwards its `raw` bytes. If the SSE parser
 * fails to extract the text, the frame is treated as an empty control frame and its raw content is
 * released UNSCANNED. The WHATWG SSE grammar allows CRLF/CR line endings, an optional single space
 * after `data:`, and multiple `data:` lines — all of which the provider SDK parses. The guard must
 * extract the same semantic text for every one of these, so scanned bytes ≡ what the SDK reads.
 * (Adversarial finding P1, 2026-09-26.)
 */
const MARKER = 'ZZ-CANARY-ZZ'

/** Build a text_delta event frame with the given newline and `data:` prefix. */
function frame(text: string, nl: '\n' | '\r\n' | '\r', dataPrefix: 'data: ' | 'data:'): string {
  const json = JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  })
  return `event: content_block_delta${nl}${dataPrefix}${json}${nl}${nl}`
}

const canaryRule: OutputRule = {
  id: 'canary',
  maxMatchLength: 32,
  assert(text: string) {
    if (text.includes(MARKER)) throw new PolicyViolation('canary', 'critical')
  },
}

test.group('SSE parsing is representation-independent', () => {
  test('LF with "data: " extracts the text_delta text (positive control)', ({ assert }) => {
    const { frames } = parseFrames(frame(MARKER, '\n', 'data: '))
    assert.equal(frames[0].text, MARKER)
  }).tags(['guards', 'security'])

  test('CRLF line endings still extract the text_delta text', ({ assert }) => {
    const { frames } = parseFrames(frame(MARKER, '\r\n', 'data: '))
    assert.lengthOf(frames, 1)
    assert.equal(frames[0].text, MARKER)
  }).tags(['guards', 'security'])

  test('a "data:" line with no space still extracts the text', ({ assert }) => {
    const { frames } = parseFrames(frame(MARKER, '\n', 'data:'))
    assert.equal(frames[0].text, MARKER)
  }).tags(['guards', 'security'])

  test('CR-only line endings still extract the text', ({ assert }) => {
    const { frames } = parseFrames(frame(MARKER, '\r', 'data: '))
    assert.equal(frames[0].text, MARKER)
  }).tags(['guards', 'security'])

  test('multiple data: lines concatenate with a newline', ({ assert }) => {
    // The JSON is split across two data: lines, which the SSE grammar joins with "\n" (still valid JSON).
    const raw =
      `event: content_block_delta\n` +
      `data: {"type":"content_block_delta","index":0,\n` +
      `data: "delta":{"type":"text_delta","text":"${MARKER}"}}\n\n`
    const { frames } = parseFrames(raw)
    assert.equal(frames[0].text, MARKER)
  }).tags(['guards', 'security'])

  for (const [name, nl, prefix] of [
    ['CRLF', '\r\n', 'data: '],
    ['no-space', '\n', 'data:'],
    ['CR', '\r', 'data: '],
  ] as const) {
    test(`a canary in a ${name} frame is scanned and withheld, not released`, async ({
      assert,
    }) => {
      const h = new HoldbackStream([canaryRule], 128)
      const { frames } = parseFrames(frame(MARKER, nl, prefix))
      const released = await h.push(frames)
      const tail = await h.end()
      assert.isNotNull(h.violation, 'the canary tripped the rule')
      assert.notInclude(released + tail, MARKER, 'the canary was never released')
    }).tags(['guards', 'security'])
  }
})
