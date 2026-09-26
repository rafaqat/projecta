import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * `node ace robustness:run` — the robustness tier (WP-24): ingest each pinned corpus
 * repository at its commit, measure, judge against `config/robustness.json`, write a report, and
 * exit non-zero when any invariant fails.
 *
 * The report goes under `tmp/robustness/` by default and never into `evals/runs/`: a run's figures
 * become the recorded baseline only through a person's pull request.
 */
export default class RobustnessRun extends BaseCommand {
  static commandName = 'robustness:run'
  static description = 'Run the robustness tier over the pinned corpus'
  static options: CommandOptions = { startApp: true }

  @flags.string({ description: 'Workspace handle the corpus is ingested into', required: true })
  declare workspace: string

  @flags.string({ description: 'Email of the workspace member the ingests run as', required: true })
  declare owner: string

  @flags.string({ description: 'Corpus and thresholds', default: 'config/robustness.json' })
  declare config: string

  @flags.string({
    description: 'Directory relative input paths resolve against (make robustness streams them in)',
  })
  declare inputs?: string

  @flags.string({ description: 'Comma-separated slugs, to run part of the corpus' })
  declare only?: string

  @flags.boolean({
    description: 'Also ask the UAT pack of each repository (needs a model the stack can reach)',
    default: false,
  })
  declare answers: boolean

  @flags.boolean({
    description: 'Carry the measurements in the report at --out and measure only what is missing',
    default: false,
  })
  declare resume: boolean

  @flags.string({ description: 'Report path' })
  declare out?: string

  async run() {
    const { runRobustness } = await import('#app/evals/robustness_runner')
    const { inputPath } = await import('#app/evals/robustness')
    const { inScope } = await import('#app/security/scope')
    const { default: db } = await import('@adonisjs/lucid/services/db')
    const measuredSoFar: Awaited<ReturnType<typeof runRobustness>>['repositories'] = []
    const readJson = async (path: string) =>
      JSON.parse(await readFile(inputPath(this.inputs, path), 'utf8'))

    const user = await db
      .from('users')
      .whereRaw('lower(email) = ?', [this.owner.trim().toLowerCase()])
      .first()
    if (!user) return this.fail(`no user ${this.owner}`)
    const workspace = await inScope({ userId: Number(user.id) }, (trx) =>
      trx.from('workspaces').where('handle', this.workspace).select('id').first()
    )
    if (!workspace) return this.fail(`no workspace ${this.workspace} that ${this.owner} belongs to`)

    // With the model server the ingesting process does not hold the embedder, and's
    // memory ceiling is the lower one.
    const mode = process.env.MODEL_SERVER_URL ? 'modelServer' : 'inProcess'

    const out =
      this.out ?? `tmp/robustness/robustness-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    await mkdir(dirname(out), { recursive: true })
    const at = new Date().toISOString()
    // Written after every repository, not at the end: a run cut short — CI's step budget, a
    // cancelled job — leaves the measurements it has already taken on disk (run 35464404085).
    const write = async (body: object) =>
      writeFile(out, JSON.stringify({ at, config: this.config, ...body }, null, 2) + '\n')
    const started = Date.now()
    // A run cut short leaves its measurements in the report; --resume carries them back in, so the
    // repository it died on is where the next run starts (owner, 2026-09-19).
    const carried = this.resume ? await this.carriedFrom(out) : []
    if (carried.length) this.logger.info(`resuming: ${carried.length} already measured`)
    await write({ complete: false, repositories: carried })
    const { verdict, repositories } = await runRobustness({
      workspaceId: String(workspace.id),
      userId: Number(user.id),
      config: await readJson(this.config),
      mode,
      only: this.only?.split(',').map((s) => s.trim()),
      answers: this.answers
        ? { pack: await readJson('evals/cases/uat/questions.json'), readJson }
        : undefined,
      carried,
      onRepository: async (report, measured, total) => {
        const mins = ((Date.now() - started) / 60_000).toFixed(1)
        this.logger.info(`${measured}/${total} ${report.slug}: ${report.status} (${mins} min)`)
        measuredSoFar.push(report)
        await write({ complete: false, repositories: [...carried, ...measuredSoFar] })
      },
    })

    await write({ complete: true, verdict, repositories })

    for (const r of verdict.repositories) {
      const failed = r.checks.filter((c) => c.gating && !c.ok).map((c) => c.name)
      if (r.ok) this.logger.success(r.slug)
      else this.logger.error(`${r.slug}: ${failed.join(', ')}`)
      // A failed invariant says why, here and in the report: which turn, which code and hash,
      // which expected citations were missed (the first paid run said only "failed turns 1").
      const measured = repositories.find((m) => m.slug === r.slug)
      for (const f of measured?.answers?.failures ?? [])
        this.logger.error(`  failed turn: [${f.area}] ${f.question} -> ${f.code} ${f.hash}`)
      for (const q of measured?.expectations?.questions ?? [])
        if (q.recall < 1)
          this.logger.info(
            `  cited ${q.cited} of ${q.expected} expected: [${q.area}] ${q.question} (missing ${q.missing.join(', ')})`
          )
    }
    if (!verdict.answersRun)
      this.logger.info('answer invariants not run (pass --answers with a reachable model)')
    this.logger.info(`report: ${out}`)
    if (!verdict.ok) this.exitCode = 1
  }

  /** The measurements a previous run left at this path; none when there is no readable report. */
  private async carriedFrom(out: string) {
    try {
      const previous = JSON.parse(await readFile(out, 'utf8'))
      return Array.isArray(previous.repositories) ? previous.repositories : []
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return []
      this.logger.error(`unreadable report at ${out} (${code ?? 'parse'}); measuring the corpus`)
      return []
    }
  }

  private fail(message: string) {
    this.logger.error(message)
    this.exitCode = 1
  }
}
