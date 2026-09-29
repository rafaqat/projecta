import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'

/**
 * The Collector holds the third key for content, and nothing was checking that it still does.
 *
 * Content used to be a span attribute, so the Collector's `redaction` allowlist could withhold it:
 * the content *was* the attribute. Content is now a log record's body, and that allowlist governs
 * attributes only — a body is not an attribute — so allowlisting `app.content.kind` labels the
 * record without gating the prose inside it. `filter/content` is the replacement (ADR-0025), and it
 * fails the way the old dead allowlist keys failed: silently, because a pipeline missing a processor
 * looks exactly like a pipeline whose processor decided to keep everything.
 *
 * So the shape is asserted here rather than trusted. This is the same textual discipline as
 * `declared_attributes.spec.ts`: one file read, no stack, and it catches the edit that would
 * otherwise be noticed only by a prompt arriving in a deployed Loki.
 */
const CONFIG = 'docker/otel/collector.yaml'

test.group('the Collector gates content log records', () => {
  test('the logs pipeline drops content unless its own key says otherwise', async ({ assert }) => {
    const config = parse(await readFile(CONFIG, 'utf8'))

    const processors: string[] = config.service.pipelines.logs.processors
    assert.include(processors, 'filter/content', 'the logs pipeline does not gate content at all')
    assert.isBelow(
      processors.indexOf('filter/content'),
      processors.length - 1,
      'the gate must run before the batch processor hands records to an exporter'
    )

    const conditions: string[] = config.processors['filter/content'].logs.log_record
    const condition = conditions.join(' ')

    // A filter drops what matches, so the condition must match when the key is *absent*. Written
    // the other way round it would forward every prompt and pass a test that only checked the
    // variable was mentioned.
    assert.include(condition, 'attributes["app.content.kind"] != nil')
    assert.include(condition, '"${env:OTEL_ALLOW_CONTENT_LOGS:-}" != "1"')

    // Two processes, two names. One `export` must not be able to open both keys at once, which is
    // the property ADR-0023 wanted from a key held outside the application.
    assert.notInclude(
      condition,
      'TELEMETRY_DEBUG_CONTENT',
      'the Collector key must not share a name with the application flag'
    )
  })
})
