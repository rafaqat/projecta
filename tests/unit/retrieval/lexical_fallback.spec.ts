import { test } from '@japa/runner'
import { isLexicalIndexFault, withLexicalFallback } from '#app/retrieval/lexical_fallback'

/** A pg driver error carries a SQLSTATE on `.code`. */
const pgError = (code: string, message = 'db error') => Object.assign(new Error(message), { code })

test.group('isLexicalIndexFault (lexical resilience)', () => {
  const faults: Array<[string, unknown]> = [
    ['XX001 data_corrupted', pgError('XX001')],
    ['XX002 index_corrupted', pgError('XX002')],
    ['XX000 internal_error', pgError('XX000')],
    ['08006 connection_failure', pgError('08006')],
    ['08003 connection_does_not_exist', pgError('08003')],
    ['57P01 admin_shutdown', pgError('57P01')],
    ['driver: connection terminated', new Error('Connection terminated unexpectedly')],
    ['driver: connection ended', new Error('Connection ended unexpectedly')],
    ['driver: ECONNRESET', new Error('read ECONNRESET')],
  ]
  for (const [name, error] of faults) {
    test(`treats ${name} as an index fault`, ({ assert }) => {
      assert.isTrue(isLexicalIndexFault(error))
    }).tags(['retrieval-resilience'])
  }

  const notFaults: Array<[string, unknown]> = [
    ['42601 syntax_error (our SQL bug)', pgError('42601')],
    ['42703 undefined_column (our SQL bug)', pgError('42703')],
    ['42P01 undefined_table (our SQL bug)', pgError('42P01')],
    ['23505 unique_violation', pgError('23505')],
    ['a plain error with no code', new Error('boom')],
    ['a non-error value', 'nope'],
    ['null', null],
  ]
  for (const [name, error] of notFaults) {
    test(`does NOT mask ${name}`, ({ assert }) => {
      assert.isFalse(isLexicalIndexFault(error))
    }).tags(['retrieval-resilience'])
  }
})

test.group('withLexicalFallback (lexical resilience)', () => {
  test('returns the primary result and never calls the fallback on success', async ({ assert }) => {
    let fallbackCalled = false
    const out = await withLexicalFallback(
      'test',
      async () => 'primary',
      async () => {
        fallbackCalled = true
        return 'fallback'
      }
    )
    assert.equal(out, 'primary')
    assert.isFalse(fallbackCalled)
  }).tags(['retrieval-resilience'])

  test('falls back when the primary throws an index fault', async ({ assert }) => {
    const out = await withLexicalFallback(
      'test',
      async () => {
        throw pgError('XX001', 'data corrupted')
      },
      async () => 'fallback'
    )
    assert.equal(out, 'fallback')
  }).tags(['retrieval-resilience'])

  test('re-throws a non-fault error and never calls the fallback (a real bug still surfaces)', async ({
    assert,
  }) => {
    let fallbackCalled = false
    await assert.rejects(
      () =>
        withLexicalFallback(
          'test',
          async () => {
            throw pgError('42601', 'syntax error')
          },
          async () => {
            fallbackCalled = true
            return 'fallback'
          }
        ),
      /syntax error/
    )
    assert.isFalse(fallbackCalled)
  }).tags(['retrieval-resilience'])
})
