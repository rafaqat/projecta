import { test } from '@japa/runner'
import { SPAN_ATTRIBUTE_ALLOWLIST } from '#app/security/telemetry/allowlist'
import { USAGE_ATTRIBUTE_KEYS, usageAttributes } from '#app/security/telemetry/usage_attributes'
import type { CallStatus } from '#app/audit/ledger'

/**
 * A round that failed mid-stream must not look free.
 *
 * The provider reports input tokens at `message_start` and everything else at `finalMessage()`, so a
 * call that throws in between knows what it spent and not what it produced. Writing `0` for the
 * output would keep a `sum()` tidy while asserting the call produced nothing, which is not what
 * happened; omitting it is honest per span and invisible in an aggregate. So the count is omitted
 * and `gen_ai.usage.complete` carries the distinction, and that pairing is what these assert.
 */
const COMPLETED: CallStatus = 'completed'

test.group('a model call reports what it cost', () => {
  test('a completed call reports every count the provider gave', ({ assert }) => {
    const attributes = usageAttributes(
      { inputTokens: 1840, outputTokens: 412, cacheReadTokens: 9600, cacheCreationTokens: 0 },
      COMPLETED
    )

    assert.deepEqual(attributes, {
      'gen_ai.usage.complete': true,
      'gen_ai.usage.input_tokens': 1840,
      'gen_ai.usage.output_tokens': 412,
      'gen_ai.usage.cache_read_input_tokens': 9600,
      // Zero is a count the provider reported, not an absence, so it is written.
      'gen_ai.usage.cache_creation_input_tokens': 0,
    })
  })

  test('a call that died mid-stream omits the output count and says so', ({ assert }) => {
    for (const status of ['failed', 'cancelled', 'running'] as CallStatus[]) {
      const attributes = usageAttributes({ inputTokens: 1840 }, status)

      assert.isFalse(attributes['gen_ai.usage.complete'], `${status} claimed to be complete`)
      assert.equal(attributes['gen_ai.usage.input_tokens'], 1840, `${status} lost its input count`)
      // On `Object.keys`, not `assert.notProperty`. Chai reads a dotted argument as a nested path,
      // so `notProperty(attributes, 'gen_ai.usage.output_tokens')` looks for `attributes.gen_ai`,
      // finds nothing and passes — while the flat key sits there holding a zero. Every attribute key
      // in this repository is dotted, so that assertion is vacuous on all of them. The ablation that
      // writes 0 here is what exposed it; the assertion had been passing without asserting.
      assert.notInclude(
        Object.keys(attributes),
        'gen_ai.usage.output_tokens',
        `${status} wrote an output count it never learned`
      )
    }
  })

  test('every key it can write is allowlisted', ({ assert }) => {
    // Both allowlists must agree for an attribute to leave the process, and a missing entry fails
    // silently — an attribute that is never exported looks exactly like one that is never set. The
    // collector's half is a YAML file checked by collector_content_gate.spec.ts's sibling concerns;
    // this is the in-process half.
    const undeclared = USAGE_ATTRIBUTE_KEYS.filter((key) => !SPAN_ATTRIBUTE_ALLOWLIST.has(key))

    assert.deepEqual(undeclared, [], 'written by usageAttributes and dropped by the exporter')
  })
})
