import { test } from '@japa/runner'
import { classifyModelError, modelErrorLabel } from '#app/assistant/model_error'
import { securityEvents } from '#app/security/events/index'
import type { SecurityEventRecord } from '#app/security/events/emitter'
import { logAttributesOf } from '#app/security/telemetry/log_records'

/**
 * A failed model call has to be identifiable from the error code alone, because the code is the only
 * part of it the collector's allowlist carries (SEC-14): the message is redacted, and the hash cannot
 * be read back. Every error class in @anthropic-ai/sdk inherits `name` from Error without assigning
 * it, so deriving the code from `error.name` produced `E_MODEL_Error` for a connection failure, a
 * timeout, a 429 and a 500 alike (UAT 2026-09-16, and again 2026-09-27 22:54 UTC). The class comes
 * from the constructor, and the operating system's errno rides along as the cause: both are closed
 * sets, never prose.
 */

/** An SDK connection failure: a subclass that never sets `name`, wrapping the resolver's errno. */
class APIConnectionError extends Error {
  constructor(cause: unknown) {
    super('Connection error.')
    this.cause = cause
  }
}

test.group('classifyModelError', () => {
  test('names the error class and the errno it wrapped', ({ assert }) => {
    const resolver = Object.assign(new Error('getaddrinfo EAI_AGAIN llm-gateway'), {
      code: 'EAI_AGAIN',
    })

    const facts = classifyModelError(new APIConnectionError(resolver))

    assert.equal(facts.code, 'E_MODEL_APIConnectionError')
    assert.equal(facts.cause, 'EAI_AGAIN')
  })
})

/**
 * The run's status line is the only place a reader of the console sees why a turn failed: the label
 * was "model error" alone, so the code the reporter had already computed never reached the page or
 * `turns.events`, and the trace was the only way to tell one failure from another.
 */
test.group('modelErrorLabel', () => {
  test('carries the code and the errno into the run status', ({ assert }) => {
    const label = modelErrorLabel({ code: 'E_MODEL_APIConnectionError', cause: 'EAI_AGAIN' })

    assert.equal(label, 'model error: E_MODEL_APIConnectionError (EAI_AGAIN)')
  })
})

/**
 * The half that decides what a dashboard can show. `error.unhandled` is catalogue-capped and the
 * exporter allowlists attributes twice (SEC-14), so a field the reporter computes but the catalogue
 * or the allowlist does not declare is dropped in silence -- which is how `E_MODEL_Error` came to be
 * the whole of what an operator could read. The agent loop is not imported here: only the in-process
 * orchestrator may (ADR-035), and tests/functional/ci/lint_rules.spec.ts enforces it.
 */
test.group('the errno survives the catalogue and the allowlist', () => {
  test('error.unhandled carries errorCause out as app.error.cause', ({ assert }) => {
    const seen: SecurityEventRecord[] = []
    const off = securityEvents.tap((r) => seen.push(r))
    try {
      securityEvents.emit('error.unhandled', {
        ...classifyModelError(new Error('x')),
        errorCode: 'E_MODEL_APIConnectionError',
        errorCause: 'EAI_AGAIN',
        errorHash: '0'.repeat(16),
        status: 502,
        requestId: 'r-1',
      })
    } finally {
      off()
    }

    const record = seen.find((r) => r.event === 'error.unhandled')
    assert.equal(record?.fields.errorCause, 'EAI_AGAIN')
    assert.equal(logAttributesOf({ securityEvent: record })['app.error.cause'], 'EAI_AGAIN')
  })
})
