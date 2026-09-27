import { configApp } from '@adonisjs/eslint-config'
import { react } from '@adonisjs/eslint-config/react'
import reactPlugin from 'eslint-plugin-react'
import security from 'eslint-plugin-security'

/**
 * INV-01 (ADR-034): only app/llm/client.ts imports @anthropic-ai/sdk, and no
 * code imports a client-side provider abstraction.
 */
const forbiddenEverywhere = [
  { name: 'ai', message: 'The Vercel AI SDK is not approved (ADR-034).' },
  {
    name: '@anthropic-ai/foundry-sdk',
    message: 'Provider selection belongs to llm-gateway (ADR-034).',
  },
]
const forbiddenPatterns = [
  { group: ['@ai-sdk/*'], message: 'The Vercel AI SDK is not approved (ADR-034).' },
]
const sdkOutsideClient = {
  name: '@anthropic-ai/sdk',
  message: 'Only app/llm/client.ts may import the provider SDK (INV-01, ADR-034).',
}
/** ADR-035: callers reach the agent loop only through the Orchestrator port. */
const agentOutsideOrchestrator = {
  // A leading # would start a glob comment, hence the escape.
  group: ['\\#app/assistant/agent', '**/app/assistant/agent', '**/assistant/agent.js'],
  message:
    'Only the in-process orchestrator (app/assistant/in_process.ts) may import the agent loop (ADR-035).',
}

/** ADR-015 / INV-20: the sequence-release decision module has no path to the model. */
const llmFromDecision = {
  group: ['\\#app/llm/*', '**/app/llm/**', '**/llm/*.js', '@anthropic-ai/sdk'],
  message: 'The critical decision path cannot import app/llm/** (ADR-015, INV-20).',
}

/**
 * ADR-036: every colour in the interface comes from a design token, so a theme
 * designer can retint the whole application. Palette classes (`bg-zinc-900`)
 * and arbitrary colours (`bg-[#7B82F0]`) bypass the tokens and are rejected in
 * any string that can reach a class attribute.
 */
const PALETTE =
  /(?:^|[\s"'`:])(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke|from|via|to|outline|decoration|divide|accent|caret|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/
const ARBITRARY =
  /(?:^|[\s"'`:])(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke|from|via|to|outline|decoration|divide|accent|caret|shadow)-\[(?:#|rgb|hsl|oklch|oklab|color)/
const designPlugin = {
  rules: {
    'token-colours': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        const check = (node, value) => {
          if (typeof value !== 'string') return
          if (PALETTE.test(value) || ARBITRARY.test(value)) {
            context.report({
              node,
              message:
                'Colours come from design tokens (bg-panel, text-content-muted…), never a palette or arbitrary value (ADR-036).',
            })
          }
        }
        return {
          Literal: (node) => check(node, node.value),
          TemplateElement: (node) => check(node, node.value.cooked),
        }
      },
    },
  },
}
/** ADR-036: Radix primitives live behind the vendored components. */
const radixOutsideUi = {
  group: ['@radix-ui/*'],
  message: 'Import primitives from ~/components/ui; only that directory may import @radix-ui/* (ADR-036).',
}
const tailwindAtRuntime = {
  group: ['tailwindcss', 'tailwindcss/*', '@tailwindcss/*'],
  message: 'Tailwind is build-time only (ADR-036).',
}

export default [
  ...configApp(...react),
  // Detects risky patterns (non-literal fs paths, child_process, unsafe regex, eval) as warnings.
  security.configs.recommended,
  {
    ignores: ['tests/fixtures/**', 'evals/fixtures/**', 'models/**', 'tmp/**', '.adonisjs/**', '**/.venv/**'],
  },
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...forbiddenEverywhere, sdkOutsideClient],
          patterns: [...forbiddenPatterns, agentOutsideOrchestrator],
        },
      ],
    },
  },
  {
    // INV-06 (ADR-028): dangerouslySetInnerHTML only inside SafeHtml.
    files: ['**/*.tsx', '**/*.jsx'],
    plugins: { react: reactPlugin },
    rules: { 'react/no-danger': 'error' },
  },
  {
    // ADR-036: tokens only, and Radix only behind inertia/components/ui.
    files: ['**/inertia/**/*.{ts,tsx}'],
    ignores: ['**/inertia/components/ui/**'],
    plugins: { design: designPlugin },
    rules: {
      'design/token-colours': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: forbiddenEverywhere,
          patterns: [...forbiddenPatterns, radixOutsideUi, tailwindAtRuntime],
        },
      ],
    },
  },
  {
    files: ['**/inertia/components/ui/**/*.{ts,tsx}'],
    plugins: { design: designPlugin },
    rules: {
      'design/token-colours': 'error',
      'no-restricted-imports': [
        'error',
        { paths: forbiddenEverywhere, patterns: [...forbiddenPatterns, tailwindAtRuntime] },
      ],
    },
  },
  {
    // The answer protocol, output policy and evidence-state rule are pure modules shared with the client (ADR-002, ADR-028, design §9).
    files: ['inertia/**/*.{ts,tsx}'],
    rules: {
      '@adonisjs/no-backend-import-in-frontend': [
        'error',
        {
          allowed: [
            '(../)+app/assistant/protocol',
            '(../)+app/assistant/output_policy',
            '(../)+app/assistant/map_layout',
            '(../)+app/assistant/answer_layout',
            '(../)+app/audit/evidence_state',
          ],
        },
      ],
    },
  },
  {
    files: ['**/app/llm/client.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: forbiddenEverywhere, patterns: [...forbiddenPatterns, agentOutsideOrchestrator] },
      ],
    },
  },
  {
    // ADR-026: thread content is hashed only through the keyed-commitment helper.
    files: [
      '**/app/assistant/turn_service.ts',
      '**/app/audit/decision_record.ts',
      '**/app/controllers/turns_controller.ts',
      '**/app/controllers/decisions_controller.ts',
      '**/tests/fixtures/lint/thread_content/**',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.name=/^(createHash|createHmac)$/], CallExpression[callee.property.name=/^(createHash|createHmac|digest)$/]',
          message:
            'Plain hashing of thread content is forbidden; use commit() from app/security/commitment (ADR-026).',
        },
      ],
    },
  },
  {
    files: ['**/app/assistant/in_process.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [...forbiddenEverywhere, sdkOutsideClient], patterns: forbiddenPatterns },
      ],
    },
  },
  {
    files: ['**/inertia/components/safe_html.tsx'],
    rules: { 'react/no-danger': 'off' },
  },
  {
    files: ['**/app/examples/sequence_release/decision/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...forbiddenEverywhere, sdkOutsideClient],
          patterns: [...forbiddenPatterns, agentOutsideOrchestrator, llmFromDecision],
        },
      ],
    },
  },
]
