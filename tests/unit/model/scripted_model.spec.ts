import { test } from '@japa/runner'
import { ScriptedModel, toolLoop } from '#tests/helpers/scripted_model'
import type { ModelRequest } from '#app/assistant/model'

/**
 * Substrate check: the scripted-LLM seam works. Slices 3 (correctness) and 4 (adversarial) swap this
 * fake in for the real model in their eval measurements, so it must implement ModelClient exactly and
 * stream its script deterministically. No provider, no network — this is what "the model works" means
 * for the LLM half of the substrate.
 */
const emptyRequest: ModelRequest = { system: '', messages: [], tools: [] }

async function collect(model: ScriptedModel, request: ModelRequest) {
  const events = []
  for await (const ev of model.stream(request, new AbortController().signal)) events.push(ev)
  return events
}

test.group('model/scripted (substrate)', () => {
  test('the scripted LLM streams its scripted turn verbatim')
    .tags(['model', 'substrate'])
    .run(async ({ assert }) => {
      const model = new ScriptedModel([
        [
          { type: 'text', delta: 'hello' },
          { type: 'end', stopReason: 'end_turn' },
        ],
      ])
      const events = await collect(model, emptyRequest)
      assert.equal(model.id, 'scripted')
      assert.deepEqual(events, [
        { type: 'text', delta: 'hello' },
        { type: 'end', stopReason: 'end_turn' },
      ])
      assert.lengthOf(model.requests, 1)
    })

  test('toolLoop scripts n tool calls then a final answer, one turn at a time')
    .tags(['model', 'substrate'])
    .run(async ({ assert }) => {
      const model = new ScriptedModel(toolLoop(2, 'Done.'))
      const t1 = await collect(model, emptyRequest)
      assert.equal(t1[0]?.type, 'tool_use')
      const t2 = await collect(model, emptyRequest)
      assert.equal(t2[0]?.type, 'tool_use')
      const t3 = await collect(model, emptyRequest)
      assert.equal(t3[0]?.type, 'text')
    })

  test('a scripted upstream abort surfaces as an aborted stream')
    .tags(['model', 'substrate'])
    .run(async ({ assert }) => {
      const model = new ScriptedModel([[{ type: 'end', stopReason: 'end_turn' }]], { hang: true })
      const controller = new AbortController()
      const iterator = model.stream(emptyRequest, controller.signal)[Symbol.asyncIterator]()
      const next = iterator.next()
      controller.abort()
      await assert.rejects(() => next)
      assert.isTrue(model.upstreamAborted)
    })
})
