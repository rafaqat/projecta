import { assert } from '@japa/assert'
import { apiClient } from '@japa/api-client'
import app from '@adonisjs/core/services/app'
import type { Config } from '@japa/runner/types'
import { pluginAdonisJS } from '@japa/plugin-adonisjs'
import { dbAssertions } from '@adonisjs/lucid/plugins/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { browserClient, decoratorsCollection } from '@japa/browser-client'
import { authBrowserClient } from '@adonisjs/auth/plugins/browser_client'
import { sessionBrowserClient } from '@adonisjs/session/plugins/browser_client'
import { spec } from '@japa/runner/reporters'
import { taggedReporter } from '#tests/reporters/tagged'

/**
 * This file is imported by the "bin/test.ts" entrypoint file
 */

// Browser-suite reliability: the full answer flow (retrieval → agent loop → stream → settle) can
// exceed Playwright's 30s default on a slow CI runner, racing the many `[data-run-state=completed]`
// waits (~1–2 per run). Raise the per-context default so those waits track a genuine hang, not a
// slow-but-healthy answer. Applies only to browser contexts — only the browser suite creates them.
decoratorsCollection.register({
  context(context) {
    context.setDefaultTimeout(60_000)
    context.setDefaultNavigationTimeout(60_000)
  },
})

/**
 * Configure Japa plugins in the plugins array.
 * Learn more - https://japa.dev/docs/runner-config#plugins-optional
 */
export const plugins: Config['plugins'] = [
  assert(),
  apiClient(),
  pluginAdonisJS(app),
  dbAssertions(app),
  browserClient({ runInSuites: ['browser'] }),
  sessionBrowserClient(app),
  authBrowserClient(app),
]

/**
 * Reporters. `spec` is the default; `tagged` is activated by `node ace verify`
 * to map test results to acceptance criteria.
 */
export const reporters: Config['reporters'] = {
  activated: ['spec'],
  list: [spec(), taggedReporter],
}

/**
 * Configure lifecycle function to run before and after all the
 * tests.
 *
 * The setup functions are executed before all the tests
 * The teardown functions are executed after all the tests
 */
export const runnerHooks: Required<Pick<Config, 'setup' | 'teardown'>> = {
  // Migrate once per process before any suite: a fresh runner starts from an empty database.
  // The returned rollback is deliberately not registered as a cleanup: the schema stays for audit:verify.
  setup: [
    async () => {
      await testUtils.db().migrate()
    },
  ],
  teardown: [],
}

/**
 * Configure suites by tapping into the test suite instance.
 * Learn more - https://japa.dev/docs/test-suites#lifecycle-hooks
 */
export const configureSuite: Config['configureSuite'] = (suite) => {
  if (['browser', 'functional', 'structural', 'e2e'].includes(suite.name)) {
    return suite.setup(() => testUtils.httpServer().start())
  }
}
