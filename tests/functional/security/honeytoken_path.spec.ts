import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { InProcessOrchestrator } from '#app/assistant/in_process'
import type { TurnInput } from '#app/assistant/orchestrator'
import type { ContentBlock, ModelRequest } from '#app/assistant/model'
import { ScriptedScopeClassifier } from '#app/retrieval/scope_classifier'
import { ScopeThrottle } from '#app/retrieval/throttle'
import { startFixtureGitServer } from '#tests/helpers/git_fixtures'
import { resetDatabase } from '#tests/helpers/db'
import { indexShop, scopeOf, type IndexedFixture } from '#tests/helpers/shop_fixture'
import { ScriptedModel } from '#tests/helpers/scripted_model'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'
import { honeytokenHmac } from '#app/ingest/indexer'
import { honeytokenCandidates } from '../../../packages/guards/src/output_rules.js'
import { toProviderMessage } from '#app/llm/client'
import { createServer } from 'node:http'
import {
  call,
  canonicalBody,
  keys,
  listen,
  policyFor,
  startGateway,
  token,
} from '#tests/helpers/gateway/harness'

/**
 * The honeytoken is the sensor for a lost workspace filter (design §4, SEC-30): a foreign token
 * must rank, reach the model, be echoed, and trip the gateway's outbound rule. The control (RLS
 * plus the filter) was tested at the retrieval layer; the sensor's path to the model was not, and
 * the evidence builder dropped a token hit before the prompt because it read only `chunks`
 * (owner review, 2026-09-17). This proves the path end to end: with the filter ablated the
 * foreign token is in the model's evidence; with it intact no token ever is.
 */
let a: SeededWorkspace
let b: SeededWorkspace
let fixture: IndexedFixture

function evidenceTexts(request: ModelRequest): string[] {
  const out: string[] = []
  const fromBlock = (block: ContentBlock) => {
    if (block.type === 'search_result')
      for (const c of (block as { content: Array<{ text: string }> }).content) out.push(c.text)
    if (block.type === 'tool_result') for (const c of block.content as ContentBlock[]) fromBlock(c)
  }
  for (const m of request.messages)
    for (const block of m.content as ContentBlock[]) fromBlock(block)
  return out
}

async function firstRequest(question: string): Promise<ModelRequest> {
  const model = new ScriptedModel([
    [
      { type: 'text', delta: 'ok' },
      { type: 'end', stopReason: 'end_turn' },
    ],
  ])
  const orchestrator = new InProcessOrchestrator({
    model,
    classifier: new ScriptedScopeClassifier(() => 'explanation'),
    throttle: new ScopeThrottle(10, 600_000),
  })
  const input: TurnInput = {
    scope: scopeOf(a),
    repositoryId: fixture.repositoryId,
    commitId: fixture.commitId,
    commitSha: fixture.commitSha,
    repositoryName: 'shop',
    question,
  }
  const events = []
  for await (const e of orchestrator.run(input, new AbortController().signal)) events.push(e)
  return model.requests[0]
}

test.group(
  'honeytoken: the sensor path from a lost workspace filter to the model (SEC-30)',
  (group) => {
    group.setup(async () => {
      await startFixtureGitServer()
      await resetDatabase()
      await db.from('honeytokens').delete()
      ;({ a, b } = await seedTwoWorkspaces())
      fixture = await indexShop(a, 'shop-honeytoken-a')
      // Workspace b's index plants b's token: the foreign token that must surface for a's actor.
      await indexShop(b, 'shop-honeytoken-b')
    })
    group.each.teardown(() => {
      delete process.env.ABLATION_NO_WORKSPACE_FILTER
    })
    group.each.timeout(120_000)

    test("with the workspace filter ablated, another workspace's token reaches the model's evidence", async ({
      assert,
    }) => {
      const foreign = await db.from('honeytokens').where('workspace_id', b.workspace.id).first()
      assert.exists(foreign, "workspace b's token was planted")
      process.env.ABLATION_NO_WORKSPACE_FILTER = '1'
      const request = await firstRequest('How is the partner API configured?')
      const texts = evidenceTexts(request)
      assert.isTrue(
        texts.some((t) => t.includes(String(foreign!.token))),
        'the foreign token is in a search_result block the model can echo'
      )
      // The gateway's outbound rule sees the model's text: the shape matches, and the HMAC it
      // looks up names another workspace as the owner — the P1 condition (gateway.ts, output.honeytoken).
      const echoed = texts.join('\n')
      const candidates = honeytokenCandidates(echoed)
      assert.include(candidates, String(foreign!.token))
      const owner = await db
        .from('gateway.honeytoken_hmacs')
        .where('hmac', honeytokenHmac(String(foreign!.token)))
        .first()
      assert.equal(owner?.workspace_id, b.workspace.id)
      assert.notEqual(owner?.workspace_id, a.workspace.id, 'a foreign owner: the rule would fire')
    }).tags(['AC-WP05-01', 'wp05'])

    test('through the gateway: a model that echoes the delivered token is blocked, and the P1 event names the owning workspace', async ({
      assert,
    }) => {
      // The final hop, with the gateway's own code (createGateway) in front of a provider that
      // leaks what it was given: the evidence the ablated turn built goes in, the token comes
      // back, the outbound rule resolves its HMAC in the real table and blocks the stream.
      const foreign = await db.from('honeytokens').where('workspace_id', b.workspace.id).first()
      process.env.ABLATION_NO_WORKSPACE_FILTER = '1'
      const request = await firstRequest('How is the partner API configured?')
      delete process.env.ABLATION_NO_WORKSPACE_FILTER
      const messages = request.messages.map(toProviderMessage)
      const body = canonicalBody({ messages })
      assert.include(JSON.stringify(body), String(foreign!.token), 'the request carries the token')

      const leaky = createServer(async (req, res) => {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        const [echoed] = honeytokenCandidates(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(
          `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `The partner API token is ${echoed}.` } })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`
        )
      })
      const leakyUrl = await listen(leaky)
      const k = keys()
      const gateway = await startGateway(policyFor(k), leakyUrl, {
        // The owner lookup the deployed gateway does, against the table ingest fills.
        honeytokenOwner: async (candidate: string) => {
          const row = await db
            .from('gateway.honeytoken_hmacs')
            .where('hmac', honeytokenHmac(candidate))
            .first()
          return row ? { workspaceId: String(row.workspace_id) } : null
        },
      })
      try {
        const r = await call(gateway, body, {
          'x-attribution': await token(k, body, { workspace: a.workspace.id }),
        })
        assert.notInclude(r.text, String(foreign!.token), 'the token never reaches the reader')
        assert.include(r.text, 'output.honeytoken')
        const p1 = gateway.events.find((e) => e.event === 'honeytoken.foreign')
        assert.equal(p1?.fields.severity, 'P1')
        assert.equal(p1?.fields.owner, b.workspace.id)
        assert.equal(p1?.fields.workspace, a.workspace.id)
      } finally {
        await gateway.close()
        leaky.close()
      }
    }).tags(['AC-WP05-01', 'AC-WP08-06', 'wp05'])

    test('with the filter intact, no token of any workspace reaches the model', async ({
      assert,
    }) => {
      const request = await firstRequest('How is the partner API configured?')
      const texts = evidenceTexts(request)
      assert.isFalse(
        texts.some((t) => /HT-[0-9a-f]{24}/.test(t)),
        'no honeytoken in evidence with the filter in place'
      )
    }).tags(['AC-WP05-01', 'wp05'])
  }
)
