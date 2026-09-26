import { mkdir, writeFile } from 'node:fs/promises'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * `node ace redteam:generate` (design §12 stage 3b): decodes the seeds,
 * applies the deterministic converters and writes the variants encoded to
 * evals/redteam/generated/variants.json, deduplicated with MinHash. Nothing
 * in plaintext leaves this process. `--decode` prints seeds for the human
 * review task and is never run by an agent.
 */
export default class RedteamGenerate extends BaseCommand {
  static commandName = 'redteam:generate'
  static description = 'Generate encoded payload variants from the encoded seeds'
  static options: CommandOptions = { startApp: false }

  @flags.boolean({
    description: 'Print decoded seeds for human review (do not run from an agent session)',
  })
  declare decode: boolean

  async run() {
    const { encodeVariants, generateVariants, loadSeeds } = await import('#app/redteam/payloads')
    const { deduplicate } = await import('#app/redteam/minhash')
    const seeds = await loadSeeds()
    if (this.decode) {
      for (const s of seeds) this.logger.log(`${s.id} [${s.objective}] ${s.text}`)
      return
    }
    const all = generateVariants(seeds)
    // Deduplicate within a technique: converters that normalisation undoes are meant to look alike.
    const kept = []
    let droppedCount = 0
    for (const technique of new Set(all.map((v) => v.technique))) {
      const group = deduplicate(
        all.filter((v) => v.technique === technique),
        (v) => v.text,
        0.95
      )
      kept.push(...group.kept)
      droppedCount += group.dropped.length
    }
    const dropped = { length: droppedCount }
    await mkdir('evals/redteam/generated', { recursive: true })
    await writeFile(
      'evals/redteam/generated/variants.json',
      JSON.stringify(encodeVariants(kept), null, 2) + '\n'
    )
    this.logger.success(
      `${kept.length} variants written (${dropped.length} duplicates dropped) from ${seeds.length} seeds`
    )
  }
}
