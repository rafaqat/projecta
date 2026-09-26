import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ratchet } from './report.ts'
import type { RunReport } from './types.ts'

/** One tier, one metric, so the ratchet can be exercised in isolation. */
function report(actual: number | null): RunReport {
  return {
    generatedAt: 'test',
    tiers: [
      {
        tier: 'correctness',
        cases: 1,
        labelled: 1,
        pending: 0,
        metrics: [
          {
            key: 'citation_precision',
            label: 'Citation precision',
            target: 0.95,
            direction: 'ge',
            actual,
            met: actual !== null && actual >= 0.95,
          },
        ],
      },
    ],
  }
}

// Canary: the ratchet must be able to fail, or it proves nothing.
test('ratchet flags a regression below the baseline', () => {
  const { regressions } = ratchet(report(0.8), report(0.9))
  assert.equal(regressions.length, 1)
})

test('ratchet passes when equal or better than the baseline', () => {
  assert.equal(ratchet(report(0.9), report(0.9)).regressions.length, 0)
  assert.equal(ratchet(report(0.95), report(0.9)).regressions.length, 0)
})

test('ratchet ignores a null actual (no system under test yet)', () => {
  assert.equal(ratchet(report(null), report(null)).regressions.length, 0)
})

test('a le-direction metric regresses when it rises', () => {
  const rep = report(0.1)
  rep.tiers[0]!.metrics[0]!.direction = 'le'
  const base = report(0.02)
  base.tiers[0]!.metrics[0]!.direction = 'le'
  assert.equal(ratchet(rep, base).regressions.length, 1)
})
