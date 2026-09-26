import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import type { UatExpectations, UatRun as UatRunRecord } from '#app/assistant/uat'

/**
 * `node ace uat:run --workspace <handle> --repository <handle> --questions <file|-> [--vars-json '{...}'] [--out <file>]`
 * asks the UAT question pack of a registered, indexed repository through the
 * real turn pipeline (the configured model: real spend) and reports each
 * turn's class: ok, failed, withheld, unverified, uncited. Exit code 1 when
 * any turn failed. Runs inside the web container (`make uat`), where the
 * gateway, models and database are reachable.
 */
export default class UatRun extends BaseCommand {
  static commandName = 'uat:run'
  static description =
    'Ask the UAT question pack of a registered repository and classify each answer'
  static options: CommandOptions = { startApp: true }

  @flags.string({ description: 'Workspace handle', required: true })
  declare workspace: string

  @flags.string({ description: 'Repository handle', required: true })
  declare repository: string

  @flags.string({ description: 'Question pack file, or - for stdin', default: '-' })
  declare questions: string

  @flags.string({ description: 'Parameters for {placeholders}, as JSON' })
  declare varsJson?: string

  @flags.string({ description: "Write every turn's events (JSON) here, for diagnosis" })
  declare dump?: string

  @flags.string({ description: 'Write the run (JSON) here' })
  declare out?: string

  @flags.string({ description: 'Ask only questions of this area' })
  declare area?: string

  @flags.string({
    description:
      'Email of the workspace member whose scope the run uses (default: the seeded developer)',
    default: 'developer@example.test',
  })
  declare owner: string

  async run() {
    // Imported here, not at the top: ace loads every command file to list them.
    const {
      expandQuestions,
      renderUatTable,
      runUat,
      scaffoldExpectations,
      scoreExpectations,
      summarise,
    } = await import('#app/assistant/uat')
    const { configHash } = await import('#app/audit/config_hash')
    const { PROMPTS } = await import('#app/assistant/prompts/index')
    const { inScope } = await import('#app/security/scope')
    const { default: db } = await import('@adonisjs/lucid/services/db')
    const { defaultOrchestrator } = await import('#app/assistant/turn_service')

    const packText =
      this.questions === '-'
        ? await new Promise<string>((resolve) => {
            let data = ''
            process.stdin.setEncoding('utf8')
            process.stdin.on('data', (chunk) => (data += chunk))
            process.stdin.on('end', () => resolve(data))
          })
        : await readFile(this.questions, 'utf8')
    const pack = JSON.parse(packText)
    const params = this.varsJson ? (JSON.parse(this.varsJson) as Record<string, string>) : {}
    const expanded = expandQuestions(pack, params)
    const questions = this.area
      ? expanded.questions.filter((q) => q.area.toLowerCase() === this.area!.toLowerCase())
      : expanded.questions

    // Row-level security: the workspace and the repository are read in the member's scope.
    const user = await db
      .from('users')
      .whereRaw('lower(email) = ?', [this.owner.trim().toLowerCase()])
      .orderBy('created_at', 'desc')
      .first()
    if (!user) {
      this.logger.error(`no user ${this.owner}; sign in (or make seed) first`)
      this.exitCode = 1
      return
    }
    const workspace = await inScope({ userId: Number(user.id) }, (trx) =>
      trx.from('workspaces').where('handle', this.workspace).select('id').first()
    )
    if (!workspace) {
      this.logger.error(`no workspace ${this.workspace} that ${this.owner} belongs to`)
      this.exitCode = 1
      return
    }
    const scope = { userId: Number(user.id), workspaceId: String(workspace.id) }
    const repository = await inScope(scope, (trx) =>
      trx
        .from('repositories')
        .join('commits', 'commits.id', 'repositories.active_commit_id')
        .where({
          'repositories.handle': this.repository,
          'repositories.workspace_id': workspace.id,
        })
        .select(
          'repositories.id',
          'repositories.name',
          'repositories.active_commit_id',
          'commits.sha'
        )
        .first()
    )
    if (!repository) {
      this.logger.error(`no indexed repository ${this.repository} in workspace ${this.workspace}`)
      this.exitCode = 1
      return
    }

    this.logger.info(
      `${questions.length} questions (${expanded.skipped.length} skipped) for ${repository.name} @ ${String(repository.sha).slice(0, 7)}`
    )
    const dumped: Record<string, unknown[]> = {}
    const cases = await runUat(
      questions,
      scope,
      {
        id: String(repository.id),
        name: String(repository.name),
        activeCommitId: String(repository.active_commit_id),
      },
      {},
      (c) =>
        this.logger.info(
          `[${c.area}] ${c.question.slice(0, 70)} → ${c.runState}, ${c.citations} citations, ${c.ms} ms`
        ),
      (question, event) => {
        if (this.dump) (dumped[question] ??= []).push(event)
      }
    )
    // Expected citations (R-08): scaffolded with every question and no expectations for a person
    // to fill; once labelled, each answer is scored by recall of what they expected.
    const expectedPath = `evals/cases/uat/expected/${String(repository.name).replace('/', '__')}.json`
    let expected: UatExpectations | null = null
    try {
      expected = JSON.parse(await readFile(expectedPath, 'utf8')) as UatExpectations
    } catch {
      expected = null
    }
    if (!expected) {
      // The scaffold is for a person; the run is the product. Inside the image `evals/` is
      // read-only (UAT 2026-09-16: the questions ran, then EACCES lost the run), so a failure
      // here is named and the run still lands.
      try {
        await mkdir(dirname(expectedPath), { recursive: true })
        await writeFile(
          expectedPath,
          JSON.stringify(scaffoldExpectations(String(repository.name), cases), null, 2) + '\n'
        )
        this.logger.info(`scaffolded ${expectedPath} for a person to label (R-08)`)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'E_SCAFFOLD'
        this.logger.warning(
          `expectation scaffold not written (${code}): ${expectedPath}; run \`uat:run\` on the host to scaffold`
        )
      }
    }
    const scored = expected ? scoreExpectations(cases, expected) : cases
    const run: UatRunRecord = {
      repository: String(repository.name),
      commit: String(repository.sha),
      model: defaultOrchestrator().modelId ?? 'unknown',
      at: new Date().toISOString(),
      configHash: configHash().hash,
      promptHash: PROMPTS.system.sha256,
      cases: scored,
      skipped: expanded.skipped,
      summary: summarise(scored),
    }
    if (this.out) {
      await mkdir(dirname(this.out), { recursive: true })
      if (this.dump) await writeFile(this.dump, JSON.stringify(dumped) + '\n')
      await writeFile(this.out, JSON.stringify(run, null, 2) + '\n')
    }
    this.logger.log(renderUatTable(run))
    if (run.summary.hasErrors) this.exitCode = 1
  }
}
