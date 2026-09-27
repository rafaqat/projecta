import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * `node ace repository:register --workspace <handle> --url <https://github.com/owner/name> [--owner email] [--name n] [--branch b]`
 * registers a repository in a workspace the way the page does (same URL
 * policy, inbox and queued ingestion) and prints the handle. Operator's
 * action for batch UAT (`scripts/uat-batch.sh`).
 */
export default class RepositoryRegister extends BaseCommand {
  static commandName = 'repository:register'
  static description = 'Register a repository in a workspace and queue its first ingestion'
  static options: CommandOptions = { startApp: true }

  @flags.string({ description: 'Workspace handle', required: true })
  declare workspace: string

  @flags.string({ description: 'Repository URL (https://, allowlisted host)', required: true })
  declare url: string

  @flags.string({ description: 'Display name (default owner/name)' })
  declare name?: string

  @flags.string({ description: 'Branch (default: the remote default branch)' })
  declare branch?: string

  @flags.string({
    description: 'Email of the workspace owner whose scope registers it',
    default: 'developer@example.test',
  })
  declare owner: string

  @flags.boolean({ description: 'Print only the handle (for scripts)', default: false })
  declare quiet: boolean

  async run() {
    // Imported here, not at the top: ace loads every command file to list them.
    const { registerRepository } = await import('#app/repositories/register')
    const { inScope } = await import('#app/security/scope')
    const { default: db } = await import('@adonisjs/lucid/services/db')
    const user = await db
      .from('users')
      .whereRaw('lower(email) = ?', [this.owner.trim().toLowerCase()])
      .orderBy('created_at', 'desc')
      .first()
    if (!user) return this.fail(`no user ${this.owner}; sign in (or make seed) first`)
    const workspace = await inScope({ userId: Number(user.id) }, (trx) =>
      trx.from('workspaces').where('handle', this.workspace).select('id').first()
    )
    if (!workspace) return this.fail(`no workspace ${this.workspace} that ${this.owner} belongs to`)
    const result = await registerRepository(
      { userId: Number(user.id), workspaceId: String(workspace.id), requestId: '' },
      { url: this.url, name: this.name, defaultRef: this.branch }
    )
    if (!result.ok) return this.fail(`${result.field}: ${result.message}`)
    if (this.quiet) this.logger.log(result.handle)
    else
      this.logger.success(
        `${result.created ? 'registered' : 'already registered:'} ${result.url} as /w/${this.workspace}/r/${result.handle}`
      )
    // The queue connection would keep the process alive after the command is done.
    const { stopIngestQueue } = await import('#app/ingest/queue')
    await stopIngestQueue()
  }

  private fail(message: string) {
    this.logger.error(message)
    this.exitCode = 1
  }
}
