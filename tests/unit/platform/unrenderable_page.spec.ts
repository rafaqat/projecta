import { test } from '@japa/runner'
import { createHash } from 'node:crypto'
import { unrenderablePageReport } from '#app/exceptions/handler'

/**
 * SEC-39: a user-facing error carries a correlation ID and nothing else. An error page that will
 * not render is reported the same way as any other failure, and never by repeating its message:
 * it fails while reporting another error, whose detail must not escape through this line.
 */
test.group('an error page that will not render (SEC-39)', () => {
  test('reports a code, the page and the correlation ID, and never the message', ({ assert }) => {
    const secret = 'Cannot resolve "/srv/app/resources/views/inertia_layout.edge"'
    const report = unrenderablePageReport('errors/not_found', new Error(secret), 'req-1234')

    assert.equal(report.errorCode, 'E_ERROR_PAGE_UNRENDERABLE')
    assert.equal(report.page, 'errors/not_found')
    assert.equal(report.correlationId, 'req-1234')
    assert.notInclude(JSON.stringify(report), secret)
    assert.notInclude(JSON.stringify(report), 'inertia_layout')
  }).tags(['AC-WP02-03', 'wp02'])

  test('the hash identifies the failure, so two reports of one cause join up', ({ assert }) => {
    const cause = new Error('renderer out of memory')
    const expected = createHash('sha256').update(cause.message).digest('hex').slice(0, 16)

    assert.equal(unrenderablePageReport('errors/server_error', cause, 'a').errorHash, expected)
    assert.equal(
      unrenderablePageReport('errors/server_error', cause, 'b').errorHash,
      unrenderablePageReport('errors/not_found', cause, 'c').errorHash
    )
  }).tags(['AC-WP02-03', 'wp02'])

  test('a thrown non-error is reported too, not dropped for having no message', ({ assert }) => {
    const report = unrenderablePageReport('errors/not_found', 'nope', 'req-9')
    assert.equal(report.errorCode, 'E_ERROR_PAGE_UNRENDERABLE')
    assert.equal(report.errorHash, createHash('sha256').update('nope').digest('hex').slice(0, 16))
  }).tags(['AC-WP02-03', 'wp02'])
})
