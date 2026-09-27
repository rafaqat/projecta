import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/** `node ace repository:status --workspace --repository [--owner]`: one line, `<status> <detail>`, for scripts. */
export default class RepositoryStatus extends BaseCommand {
  static commandName = 'repository:status'
  static description =
    "Print a repository's ingestion status (indexed, indexing, registered, failed <reason>)"
  static options: CommandOptions = { startApp: true }

  @flags.string({ description: 'Workspace handle', required: true })
  declare workspace: string

  @flags.string({ description: 'Repository handle', required: true })
  declare repository: string

  @flags.string({ description: 'Email of a workspace member', default: 'developer@example.test' })
  declare owner: string

  async run() {
    const { inScope } = await import('#app/security/scope')
    const { default: db } = await import('@adonisjs/lucid/services/db')
    const user = await db
      .from('users')
      .whereRaw('lower(email) = ?', [this.owner.trim().toLowerCase()])
      .orderBy('created_at', 'desc')
      .first()
    if (!user) {
      this.logger.log('unknown user')
      this.exitCode = 1
      return
    }
    const workspace = await inScope({ userId: Number(user.id) }, (trx) =>
      trx.from('workspaces').where('handle', this.workspace).select('id').first()
    )
    const row = workspace
      ? await inScope({ userId: Number(user.id), workspaceId: String(workspace.id) }, (trx) =>
          trx
            .from('repositories as r')
            .leftJoin('ingest_steps as s', (join) =>
              join.on('s.repository_id', 'r.id').andOnVal('s.step', '=', 'index')
            )
            .where({ 'r.handle': this.repository, 'r.workspace_id': workspace.id })
            .select('r.status', 'r.status_detail', 's.progress', 's.started_at')
            .orderBy('s.started_at', 'desc')
            .first()
        )
      : null
    if (!row) {
      this.logger.log('unknown repository')
      this.exitCode = 1
      return
    }
    // While indexing, the running step's `done/total` so a script can tell progress from a stall.
    const progress = row.progress as { done?: number; total?: number } | null
    const detail = row.status_detail
      ? String(row.status_detail).replace(/\s+/g, ' ').slice(0, 160)
      : progress && row.status !== 'indexed'
        ? `${progress.done ?? 0}/${progress.total ?? 0}`
        : ''
    this.logger.log(`${row.status}${detail ? ' ' + detail : ''}`)
  }
}
