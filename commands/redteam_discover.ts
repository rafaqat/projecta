import { mkdir, writeFile } from 'node:fs/promises'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * `node ace redteam:discover` (ADR-0006, Architecture A): the bridge of the automated adversarial
 * discovery lane. It reads the PyRIT-generated variants (staged, base64 — produced offline by
 * `make redteam-generate`) and writes a CANDIDATE case file the existing live lane can execute:
 *
 *   node ace redteam:run --live --workspace <ws> --repository <repo> \
 *     --cases evals/redteam/generated/discovered-cases.json \
 *     --variants evals/redteam/generated/pyrit-variants.json
 *
 * The candidate file is staging only: `approved_by`/`approved_at` are null and the payloads stay in
 * the variants file (base64). Promotion of any breach into evals/redteam/cases/regression.json is a
 * human step (R-06/R-08); this command never promotes. Offline/UAT only — never run in CI.
 */
export default class RedteamDiscover extends BaseCommand {
  static commandName = 'redteam:discover'
  static description =
    'Bridge PyRIT-generated variants into candidate live red-team cases (ADR-0006)'
  static options: CommandOptions = { startApp: false }

  @flags.string({
    description: 'Staged PyRIT variants (encoded)',
    default: 'evals/redteam/generated/pyrit-variants.json',
  })
  declare variants: string

  @flags.string({
    description: 'Where to write the candidate case file',
    default: 'evals/redteam/generated/discovered-cases.json',
  })
  declare out: string

  async run() {
    const { loadVariants } = await import('#app/redteam/payloads')
    const { variantsToCaseFile } = await import('#app/redteam/discover')
    const variants = await loadVariants(this.variants)
    const { file, skipped } = variantsToCaseFile(variants)
    await mkdir('evals/redteam/generated', { recursive: true })
    await writeFile(this.out, JSON.stringify(file, null, 2) + '\n')
    this.logger.success(`${file.cases.length} candidate cases written to ${this.out}`)
    if (skipped.length)
      this.logger.info(
        `${skipped.length} variants skipped (objective not deliverable as a user_question probe)`
      )
    this.logger.info(
      `next: node ace redteam:run --live --workspace <ws> --repository <repo> --cases ${this.out} --variants ${this.variants}`
    )
    this.logger.warning(
      'candidates are NOT promoted; a person reviews each before regression.json (R-06/R-08)'
    )
  }
}
