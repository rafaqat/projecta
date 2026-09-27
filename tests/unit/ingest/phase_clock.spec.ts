import { test } from '@japa/runner'
import { newPhaseClock } from '#app/ingest/phase_clock'

/**
 * Where an ingest run spent its time. The step table already times whole steps, but `index` holds
 * parsing, embedding and writing together, so a claim about which of them is the bottleneck had
 * nothing to rest on. These are wall-clock totals per phase, from an injected clock so the test is
 * deterministic.
 */
test.group('ingest phase clock', () => {
  test('attributes elapsed time to the phase that ran', async ({ assert }) => {
    let now = 1_000
    const clock = newPhaseClock(() => now)

    await clock.time('parse', async () => {
      now += 30
    })
    await clock.time('embed', async () => {
      now += 120
    })

    assert.deepEqual(clock.totals(), { parse: 30, embed: 120 })
  }).tags(['AC-WP03-01', 'wp03'])

  test('a phase entered many times accumulates, once per file', async ({ assert }) => {
    let now = 0
    const clock = newPhaseClock(() => now)

    for (const cost of [5, 7, 9]) {
      await clock.time('parse', async () => {
        now += cost
      })
    }

    assert.deepEqual(clock.totals(), { parse: 21 })
  }).tags(['AC-WP03-01', 'wp03'])

  test('a phase that throws still reports the time it spent', async ({ assert }) => {
    let now = 0
    const clock = newPhaseClock(() => now)

    await assert.rejects(() =>
      clock.time('embed', async () => {
        now += 500
        throw new Error('model server refused')
      })
    )

    // A run that failed slowly is the case a reader most needs the breakdown for.
    assert.deepEqual(clock.totals(), { embed: 500 })
  }).tags(['AC-WP03-01', 'wp03'])
})
