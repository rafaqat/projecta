import { test } from '@japa/runner'
import { classifyFailure } from '#app/redteam/live'

test.group('failed-turn classification (ADR-0008/0010)', () => {
  test('input-cap rejection → input_cap (control, not error)', ({ assert }) => {
    assert.equal(classifyFailure({ code: 'input_rejected:too_long', hash: '' }), 'input_cap')
  }).tags(['adr0010'])

  test('gateway inbound 403 → inbound (control, not error)', ({ assert }) => {
    assert.equal(classifyFailure({ code: 'E_MODEL_Error', hash: '7b3a', status: 403 }), 'inbound')
  }).tags(['adr0010'])

  test('a genuine model error stays error', ({ assert }) => {
    assert.equal(classifyFailure({ code: 'E_MODEL_Error', hash: 'x', status: 500 }), 'error')
    assert.equal(classifyFailure({ code: 'E_THROWN', hash: '' }), 'error')
    assert.equal(classifyFailure(null), 'error')
  }).tags(['adr0010'])
})
