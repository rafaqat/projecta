import { test } from '@japa/runner'
import { aggregateLive, type LiveCase } from '#app/redteam/live'

/** A case row with the fields the aggregate reads; everything else is fixed. */
const row = (
  id: string,
  blockedBy: LiveCase['blockedBy'],
  markerReleased = false,
  modelCalls = 1
): LiveCase => ({
  id,
  threat: 'T-00',
  objective: 'o',
  technique: 'plain',
  entryPoint: 'user_question',
  question: 'q',
  runState: 'completed',
  withheldBy: null,
  policies: [],
  views: [],
  modelCalls,
  blockedBy,
  markerReleased,
  releasedChars: 0,
  citations: 0,
  failedChecks: [],
  informational: [],
  pass: true,
  ms: 1,
  error: null,
  paired: null,
})

test.group('red-team live aggregate (design §12 lane 1)', () => {
  test('per case: runs, model calls, marker-released count and the layers that stopped it, over every run', ({
    assert,
  }) => {
    const runs = [
      [row('rt-a', 'none', true), row('rt-b', 'gateway'), row('rt-c', 'not_called', false, 0)],
      [row('rt-a', 'none', true), row('rt-b', 'gateway'), row('rt-c', 'not_called', false, 0)],
      [row('rt-a', 'output_gate'), row('rt-b', 'gateway'), row('rt-c', 'not_called', false, 0)],
    ]
    const a = aggregateLive(runs)
    assert.equal(a.runs, 3)
    assert.deepEqual(a.cases['rt-a'], {
      runs: 3,
      modelCalled: 3,
      markerReleased: 2,
      blockedBy: { none: 2, output_gate: 1 },
    })
    assert.deepEqual(a.cases['rt-b'], {
      runs: 3,
      modelCalled: 3,
      markerReleased: 0,
      blockedBy: { gateway: 3 },
    })
    assert.deepEqual(a.cases['rt-c'], {
      runs: 3,
      modelCalled: 0,
      markerReleased: 0,
      blockedBy: { not_called: 3 },
    })
    // Rates are over turns where the model was asked: a case the index answers measures nothing.
    assert.equal(a.measured, 6)
    assert.equal(a.markerReleased, 2)
    assert.closeTo(a.markerReleasedRate, 2 / 6, 1e-9)
    assert.equal(a.complied, 5, 'the model complied where a marker was released or a rule fired')
    assert.closeTo(a.compliedRate, 5 / 6, 1e-9)
  }).tags(['AC-WP10-03', 'wp10'])
})
