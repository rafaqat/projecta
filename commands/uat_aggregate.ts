import { readFile } from 'node:fs/promises'
import { BaseCommand, args } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * `node ace uat:aggregate tmp/uat/*.json`: one table over several UAT runs
 * (one repository each): the classes per repository, and the names the
 * verifier could not place ranked by how many repositories raised them,
 * which is where extractor gaps show as a pattern rather than a one-off.
 */
export default class UatAggregate extends BaseCommand {
  static commandName = 'uat:aggregate'
  static description =
    'Summarise several UAT runs: classes per repository and the names most often unplaced'
  static options: CommandOptions = { startApp: false }

  @args.spread({ description: 'Run files written by uat:run' })
  declare files: string[]

  async run() {
    const { classify } = await import('#app/assistant/uat')
    const rows: string[] = []
    const gapRepos = new Map<string, Set<string>>()
    const totals = {
      ok: 0,
      failed: 0,
      missed: 0,
      blocked: 0,
      withheld: 0,
      unverified: 0,
      uncited: 0,
    }
    for (const file of this.files) {
      const run = JSON.parse(await readFile(file, 'utf8')) as {
        repository: string
        commit: string
        // Runs before 2026-09-15 carry no `policies`.
        cases: Array<
          Omit<Parameters<typeof classify>[0], 'policies' | 'citedPaths' | 'citedSymbols'> & {
            policies?: string[]
            citedPaths?: string[]
            citedSymbols?: string[]
          }
        >
        summary: { indexGaps: string[]; failures: Array<{ code: string }> }
      }
      const counts = {
        ok: 0,
        failed: 0,
        missed: 0,
        blocked: 0,
        withheld: 0,
        unverified: 0,
        uncited: 0,
      }
      for (const c of run.cases)
        counts[
          classify({
            ...c,
            policies: c.policies ?? [],
            citedPaths: c.citedPaths ?? [],
            citedSymbols: c.citedSymbols ?? [],
          })
        ]++
      for (const k of Object.keys(counts) as Array<keyof typeof counts>) totals[k] += counts[k]
      for (const name of run.summary.indexGaps) {
        if (!gapRepos.has(name)) gapRepos.set(name, new Set())
        gapRepos.get(name)!.add(run.repository)
      }
      rows.push(
        `| ${run.repository} | ${run.commit.slice(0, 7)} | ${run.cases.length} | ${counts.ok} | ${counts.failed} | ${counts.missed} | ${counts.blocked} | ${counts.withheld} | ${counts.unverified} | ${counts.uncited} | ${run.summary.failures.map((f) => f.code).join(' ') || ''} |`
      )
    }
    this.logger.log(
      '| repository | commit | questions | ok | failed | missed | blocked | withheld | unverified | uncited | failure codes |'
    )
    this.logger.log('|---|---|---|---|---|---|---|---|---|---|---|')
    for (const row of rows) this.logger.log(row)
    this.logger.log(
      `| total | | | ${totals.ok} | ${totals.failed} | ${totals.missed} | ${totals.blocked} | ${totals.withheld} | ${totals.unverified} | ${totals.uncited} | |`
    )
    const ranked = [...gapRepos.entries()].sort(
      (a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0])
    )
    this.logger.log('')
    this.logger.log(
      `names the verifier could not place, by repositories raising them (${ranked.length}):`
    )
    for (const [name, repos] of ranked.slice(0, 60))
      this.logger.log(`  ${String(repos.size).padStart(2)}  ${name}`)
  }
}
