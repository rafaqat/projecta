import { test } from '@japa/runner'
import { configHash } from '#app/audit/config_hash'
import { PROMPTS } from '#app/assistant/prompts/index'
import type { ModelStreamEvent } from '#app/assistant/model'
import { readOnlyTools } from '#app/assistant/tools'
import { createModelClient, MODELS, type OutputBlockedError } from '#app/llm/client'
import { publicJwk } from '#app/security/attribution'
import { promptHashOf, toolHashOf } from '../../../services/llm-gateway/src/policy.js'
import {
  CANARY,
  keys,
  policyFor,
  recordingProvider,
  startGateway,
  type Started,
} from '#tests/helpers/gateway/harness'
import { resetDatabase } from '#tests/helpers/db'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'

/**
 * Hold-back never rewrites (WP-19, BL-04): when a rule fires mid-message the
 * gateway ends the stream, and everything the adapter received before that
 * is byte-identical to what the provider sent, block indices included. A
 * citation can therefore never be shifted onto another span by a control.
 */
let gw: Started
let provider: ReturnType<typeof recordingProvider>
let a: SeededWorkspace

test.group('hold-back and native citations (WP-19, BL-04)', (group) => {
  group.setup(async () => {
    await resetDatabase()
    ;({ a } = await seedTwoWorkspaces())
    provider = recordingProvider('citation_then_canary.sse', { delayMs: 5 })
    const upstream = await provider.listen()
    const tools = readOnlyTools({
      scope: { userId: a.owner.id },
      commitId: '',
      evidence: null as never,
    })
    gw = await startGateway(
      policyFor(keys(), {
        models: [MODELS.answer],
        configHashes: [configHash().hash],
        promptHashes: [promptHashOf(PROMPTS.system.text)!],
        toolDefinitionHashes: [
          toolHashOf(
            tools.map((t) => ({
              name: t.spec.name,
              description: t.spec.description,
              input_schema: t.spec.inputSchema,
            }))
          ),
        ],
        attributionKeys: {
          web: (await publicJwk('web')) as never,
          worker: (await publicJwk('worker')) as never,
        },
      }),
      upstream
    )
  })
  group.teardown(async () => {
    await gw.close()
    provider.server.close()
  })

  test('a canary in the answer ends the stream as a policy violation and withholds the whole answer (ADR-0007 buffering)', async ({
    assert,
  }) => {
    const model = createModelClient(MODELS.answer, { baseURL: gw.url, apiKey: 'test-token' })
    const tools = readOnlyTools({
      scope: { userId: a.owner.id },
      commitId: '',
      evidence: null as never,
    })
    const events: ModelStreamEvent[] = []
    let failure: unknown
    try {
      for await (const event of model.stream(
        {
          system: PROMPTS.system.text,
          tools: tools.map((t) => t.spec),
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'search_result',
                  source: 'r1',
                  title: 'src/services/PaymentService.ts',
                  content: [
                    { type: 'text', text: 'async refundPayment(paymentIntentId: string) {' },
                    {
                      type: 'text',
                      text: '  return stripe.refunds.create({ payment_intent: paymentIntentId })',
                    },
                  ],
                },
                { type: 'text', text: 'How is a refund processed?' },
              ],
            },
          ],
        },
        new AbortController().signal,
        {
          userId: a.owner.id,
          workspaceId: a.workspace.id,
          requestId: 'req-holdback',
          purpose: 'answer',
        }
      )) {
        events.push(event)
      }
    } catch (error) {
      failure = error
    }
    assert.exists(failure, 'the stream ends in a policy violation, never in end_turn')
    // The block is a typed decision, not a failed model call (batch UAT 2026-09-15: a question
    // about external services drew a URL, the gateway blocked it, the reader saw "the turn failed").
    const blocked = failure as OutputBlockedError
    assert.equal(blocked.code, 'E_OUTPUT_BLOCKED')
    assert.equal(blocked.rule, 'output.canary')
    const text = events
      .filter((e): e is Extract<ModelStreamEvent, { type: 'text' }> => e.type === 'text')
      .map((e) => e.delta)
      .join('')
    // ADR-0007: masking buffers the whole answer, so an output violation withholds the entire answer,
    // not only the text from the violation onward. Nothing is delivered (not even the citation and the
    // text before the canary) and the reader is shown that the turn was blocked.
    assert.equal(text, '', 'the whole answer is withheld on a canary, not partially delivered')
    assert.notInclude(text, CANARY)
    assert.isTrue(
      gw.events.some((e) => e.event === 'policy.enforced' && e.fields.rule === 'output.canary')
    )
  }).tags(['AC-WP19-10', 'wp19'])
})
