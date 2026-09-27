import { test } from '@japa/runner'
import {
  isLexicalIndexFault,
  lexicalFaultCount,
  lexicalFaultReport,
  resetLexicalFaultCount,
  withLexicalFallback,
} from '#app/retrieval/lexical_fallback'

/** A pg driver error carries a SQLSTATE on `.code`. */
const pgError = (code: string, message = 'db error') => Object.assign(new Error(message), { code })

test.group('isLexicalIndexFault (lexical resilience)', () => {
  const faults: Array<[string, unknown]> = [
    ['XX001 data_corrupted', pgError('XX001')],
    ['42704 undefined_object (a workspace with no BM25 corpus yet, ADR-022)', pgError('42704')],
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

/**
 * What a fault report says about itself. A BM25 index fault degrades retrieval silently, so the
 * one line it leaves is the whole account: CI ran with 41 of them (XX001, data_corrupted, from
 * both bm25 indexes) and none could be diagnosed, because the driver puts the failing SQL on
 * `.message` and the Postgres diagnostics naming the fault were dropped.
 */
test.group('lexicalFaultReport (lexical resilience)', () => {
  const corrupted = Object.assign(
    new Error('select c.id from chunks c where c.search_text <@> $1'),
    {
      code: 'XX001',
      severity: 'ERROR',
      routine: 'bm25_segment_read',
      detail: 'segment 3 page 41 checksum mismatch',
      where: 'bm25 index scan',
    }
  )

  test('names the Postgres diagnostics that identify the fault', ({ assert }) => {
    const report = lexicalFaultReport(corrupted, 'searchLexical')

    assert.equal(report.errorCode, 'XX001')
    assert.equal(report.site, 'searchLexical')
    assert.equal(report.routine, 'bm25_segment_read')
    assert.equal(report.detail, 'segment 3 page 41 checksum mismatch')
    assert.equal(report.where, 'bm25 index scan')
  }).tags(['retrieval-resilience'])

  test('does not repeat the failing SQL, which is what made the line unreadable', ({ assert }) => {
    const report = lexicalFaultReport(corrupted, 'searchLexical')

    assert.notInclude(JSON.stringify(report), 'select c.id')
    assert.notInclude(JSON.stringify(report), 'chunks')
    // The hash still joins repeats of one fault together.
    assert.match(report.errorHash, /^[0-9a-f]{16}$/)
  }).tags(['retrieval-resilience'])

  test('a fault with no diagnostics still reports its code', ({ assert }) => {
    const report = lexicalFaultReport(pgError('08006', 'connection failure'), 'searchLexical')

    assert.equal(report.errorCode, '08006')
    assert.isUndefined(report.routine)
  }).tags(['retrieval-resilience'])
})

/**
 * The fallback is silent by design, so the only way to know how often retrieval degrades is to
 * count it. Without a count the rate is unmeasurable: 52 faults in one CI run went unnoticed
 * because a warning line is the whole trace.
 */
test.group('lexical fault count (lexical resilience)', () => {
  test('a fault that falls back is counted; a clean call is not', async ({ assert }) => {
    resetLexicalFaultCount()

    await withLexicalFallback(
      'test',
      async () => 'primary',
      async () => 'fallback'
    )
    assert.equal(lexicalFaultCount(), 0, 'a clean call counts nothing')

    const out = await withLexicalFallback(
      'test',
      async () => {
        throw pgError('XX001', 'data corrupted')
      },
      async () => 'fallback'
    )
    assert.equal(out, 'fallback')
    assert.equal(lexicalFaultCount(), 1, 'the degraded call is counted')
  }).tags(['retrieval-resilience'])
})
