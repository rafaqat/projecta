import { readFile, writeFile } from 'node:fs/promises'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * `node ace redteam:aggregate --runs a.json,b.json,c.json [--out file]`
 * folds several `redteam:run --live` run files into one table: per case,
 * how often the model was asked, how often a marker reached the reader,
 * which layer stopped it; overall, the marker-released and complied rates
 * over the turns where the model was asked (design §12 lane 1).
 */
export default class RedteamAggregate extends BaseCommand {
  static commandName = 'redteam:aggregate'
  static description = 'Aggregate several live red-team runs into one rate table'
  static options: CommandOptions = { startApp: false }

  @flags.string({ description: 'Run files, comma-separated', required: true })
  declare runs: string

  @flags.string({
    description: 'Where to write the aggregate',
    default: 'evals/runs/redteam-live-aggregate.json',
  })
  declare out: string

  async run() {
    const { aggregateLive } = await import('#app/redteam/live')
    const files = this.runs
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean)
    const runs = []
    let model = ''
    for (const file of files) {
      const run = JSON.parse(await readFile(file, 'utf8')) as {
        model: string
        cases: Parameters<typeof aggregateLive>[0][number]
      }
      model = run.model
      runs.push(run.cases)
    }
    const aggregate = aggregateLive(runs)
    const out = { at: new Date().toISOString(), model, files, ...aggregate }
    await writeFile(this.out, JSON.stringify(out, null, 2) + '\n')
    const lines = [
      `## Red-team live aggregate (${model}, ${aggregate.runs} runs)`,
      '',
      '| Case | Runs | Model called | Marker released | Blocked by |',
      '|---|---|---|---|---|',
      ...Object.entries(aggregate.cases).map(
        ([id, c]) =>
          `| ${id} | ${c.runs} | ${c.modelCalled} | ${c.markerReleased} | ${Object.entries(
            c.blockedBy
          )
            .map(([k, n]) => `${k} ${n}`)
            .join(', ')} |`
      ),
      '',
      `Measured turns ${aggregate.measured} · marker released ${aggregate.markerReleased} (${(aggregate.markerReleasedRate * 100).toFixed(1)}%) · model complied ${aggregate.complied} (${(aggregate.compliedRate * 100).toFixed(1)}%, lower bound)`,
    ]
    this.logger.log(lines.join('\n'))
  }
}
