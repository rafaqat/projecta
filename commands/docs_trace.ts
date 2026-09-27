import { readFile, writeFile } from 'node:fs/promises'
import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * `node ace docs:trace` regenerates the red-team traceability matrix
 * (docs/traceability-redteam.md) from the threat model, the frozen cases and
 * the last published run, so the committed document is a function of the code
 * and never hand-maintained. The suite asserts the committed file equals this
 * output, so a stale matrix fails CI until it is regenerated.
 */
export default class DocsTrace extends BaseCommand {
  static commandName = 'docs:trace'
  static description =
    'Regenerate the red-team traceability matrix from threats, cases and the last run'
  static options: CommandOptions = { startApp: false }

  async run() {
    const { loadThreats, renderMatrix } = await import('#app/redteam/matrix')
    const { loadCases } = await import('#app/redteam/runner')
    const threats = await loadThreats()
    const cases = await loadCases()
    let last: unknown = null
    try {
      last = JSON.parse(await readFile('evals/runs/redteam-latest.json', 'utf8'))
    } catch {
      last = null // no published run yet; the matrix renders "not run"
    }
    const matrix = renderMatrix(threats, cases, last as Parameters<typeof renderMatrix>[2])
    await writeFile('docs/traceability-redteam.md', matrix)
    this.logger.info('wrote docs/traceability-redteam.md')
  }
}
