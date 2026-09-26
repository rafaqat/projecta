import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * `node ace repository:reindex --workspace <handle> --stale` — queues a forced re-derive of every
 * repository in the workspace whose index was cut by another chunker. The worker runs
 * the jobs one at a time; no model is called by an ingest. `--dry-run` lists them without queuing.
 */
export default class RepositoryReindex extends BaseCommand {
  static commandName = 'repository:reindex'
  static description =
    'Queue a forced re-index of the repositories whose chunks predate the current chunker'
  static options: CommandOptions = { startApp: true }

  @flags.string({ description: 'Workspace handle', required: true })
  declare workspace: string

  @flags.string({ description: 'Email of a workspace member the ingests run as', required: true })
  declare owner: string

  @flags.boolean({
    description: 'Only repositories not on the current chunker (the only mode for now)',
    default: true,
  })
  declare stale: boolean

  @flags.boolean({ description: 'List what would be queued, queue nothing', default: false })
  declare dryRun: boolean

  async run() {
    const { inScope } = await import('#app/security/scope')
    const { default: db } = await import('@adonisjs/lucid/services/db')
    const { CURRENT_VERSIONS, reindexStale, staleRepositories } =
      await import('#app/ingest/reindex')
    const user = await db
      .from('users')
      .whereRaw('lower(email) = ?', [this.owner.trim().toLowerCase()])
      .first()
    if (!user) return this.fail(`no user ${this.owner}`)
    const workspace = await inScope({ userId: Number(user.id) }, (trx) =>
      trx.from('workspaces').where('handle', this.workspace).select('id').first()
    )
    if (!workspace) return this.fail(`no workspace ${this.workspace} that ${this.owner} belongs to`)
    const scope = { userId: Number(user.id), workspaceId: String(workspace.id) }
    if (this.dryRun) {
      const stale = await staleRepositories(scope)
      for (const r of stale)
        this.logger.info(
          `${r.name} (${r.handle}): ${r.versions.join(',') || 'no chunks'} -> ${CURRENT_VERSIONS}`
        )
      this.logger.info(`${stale.length} repositories would be re-indexed`)
      return
    }
    const { ingestQueue } = await import('#app/ingest/queue')
    const queued = await reindexStale(scope, scope.userId)
    // The queue client keeps the process alive; a command that has queued its jobs is done.
    const queue = await ingestQueue()
    await queue.stop({ graceful: true, timeout: 10_000 })
    for (const r of queued)
      this.logger[r.queued ? 'success' : 'warning'](
        `${r.name} (${r.handle}): ${r.versions.join(',') || 'no chunks'} -> ${CURRENT_VERSIONS}${r.queued ? '' : ' (already queued)'}`
      )
    this.logger.info(`${queued.filter((r) => r.queued).length} of ${queued.length} queued`)
  }

  private fail(message: string) {
    this.logger.error(message)
    this.exitCode = 1
  }
}
