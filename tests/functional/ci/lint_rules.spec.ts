import { test } from '@japa/runner'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const FIXTURES = 'tests/fixtures/lint'

/** Runs ESLint on one fixture and returns the rule IDs it reports. */
async function ruleIdsFor(file: string): Promise<string[]> {
  const args = ['eslint', '--no-ignore', '--format', 'json', `${FIXTURES}/${file}`]
  let stdout: string
  try {
    ;({ stdout } = await run('npx', args))
  } catch (error) {
    stdout = (error as { stdout: string }).stdout
  }
  const [result] = JSON.parse(stdout) as Array<{ messages: Array<{ ruleId: string | null }> }>
  return result.messages.map((m) => m.ruleId ?? 'parse-error')
}

test.group('ESLint invariants INV-01 and INV-06', (group) => {
  group.each.timeout(60_000)

  test('@anthropic-ai/sdk imported outside app/llm/client.ts fails', async ({ assert }) => {
    assert.include(await ruleIdsFor('sdk_outside_client.ts'), 'no-restricted-imports')
  }).tags(['AC-WP01-09', 'wp01'])

  test('ai, @ai-sdk/anthropic and @anthropic-ai/foundry-sdk fail anywhere', async ({ assert }) => {
    for (const file of ['vercel_ai.ts', 'ai_sdk_anthropic.ts', 'foundry_sdk.ts']) {
      assert.include(await ruleIdsFor(file), 'no-restricted-imports', file)
    }
  }).tags(['AC-WP01-09', 'wp01'])

  test('dangerouslySetInnerHTML outside SafeHtml fails', async ({ assert }) => {
    assert.include(await ruleIdsFor('dangerous_html.tsx'), 'react/no-danger')
  }).tags(['AC-WP01-09', 'wp01'])

  test('the two sanctioned locations pass', async ({ assert }) => {
    assert.notInclude(await ruleIdsFor('app/llm/client.ts'), 'no-restricted-imports')
    assert.notInclude(await ruleIdsFor('inertia/components/safe_html.tsx'), 'react/no-danger')
  }).tags(['AC-WP01-09', 'wp01'])
})

test.group('ESLint and typecheck invariants for the Orchestrator port', (group) => {
  group.each.timeout(120_000)

  test('importing app/assistant/agent.ts from anywhere but the in-process orchestrator fails', async ({
    assert,
  }) => {
    assert.include(await ruleIdsFor('agent_outside_orchestrator.ts'), 'no-restricted-imports')
    assert.notInclude(
      await ruleIdsFor('../../../app/assistant/in_process.ts'),
      'no-restricted-imports'
    )
  }).tags(['AC-WP06-20', 'wp06'])

  test('a client rendering table that omits a RunState fails type checking', async ({ assert }) => {
    let output = ''
    try {
      ;({ stdout: output } = await run('npx', [
        'tsc',
        '-p',
        'tests/fixtures/typecheck/tsconfig.json',
      ]))
    } catch (error) {
      output = (error as { stdout: string }).stdout
    }
    assert.include(output, 'run_state_missing.tsx')
    assert.match(output, /awaiting_input/)
  }).tags(['AC-WP06-23', 'wp06'])
})

test.group('ESLint invariant for keyed commitments', (group) => {
  group.each.timeout(120_000)

  test('plain hashing of thread content outside the commitment helper fails', async ({
    assert,
  }) => {
    assert.include(await ruleIdsFor('thread_content/plain_hash.ts'), 'no-restricted-syntax')
    assert.notInclude(
      await ruleIdsFor('../../../app/audit/decision_record.ts'),
      'no-restricted-syntax'
    )
    assert.notInclude(
      await ruleIdsFor('../../../app/assistant/turn_service.ts'),
      'no-restricted-syntax'
    )
  }).tags(['AC-WP07-05', 'wp07'])
})

test.group('ESLint rules for the design tokens and primitives', (group) => {
  group.each.timeout(60_000)

  test('a palette colour class or an arbitrary colour class fails', async ({ assert }) => {
    assert.include(await ruleIdsFor('inertia/pages/palette_colour.tsx'), 'design/token-colours')
    assert.include(await ruleIdsFor('inertia/pages/arbitrary_colour.tsx'), 'design/token-colours')
    assert.notInclude(await ruleIdsFor('inertia/pages/token_colour.tsx'), 'design/token-colours')
  }).tags(['AC-WP16-02', 'wp16'])

  test('@radix-ui/* imported outside inertia/components/ui/** fails', async ({ assert }) => {
    assert.include(await ruleIdsFor('inertia/pages/radix_outside_ui.tsx'), 'no-restricted-imports')
    assert.notInclude(await ruleIdsFor('inertia/components/ui/dialog.tsx'), 'no-restricted-imports')
  }).tags(['AC-WP16-03', 'wp16'])
})
