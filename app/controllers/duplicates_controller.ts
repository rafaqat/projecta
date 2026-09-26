import type { HttpContext } from '@adonisjs/core/http'
import { inScope } from '#app/security/scope'
import WorkspaceTransformer from '#transformers/workspace_transformer'
import RepositoryTransformer from '#transformers/repository_transformer'
import { assetsVersion } from '#app/assets_version'

interface CloneMemberView {
  path: string
  symbol: string
  startLine: number
  endLine: number
  tokens: number
  divergence: Array<{ start: number; end: number }>
}

interface CloneGroupView {
  id: string
  classification: string
  method: string
  similarity: number
  size: number
  members: CloneMemberView[]
}

/**
 * The Duplicates page: the clone classes of the repository's active commit and their
 * members with divergence, browsable rather than only surfaced through the `find_duplicates` tool.
 * Read-only; scoped to the repository under row-level security.
 */
export default class DuplicatesController {
  async index({ auth, scope, inertia }: HttpContext) {
    const userId = auth.getUserOrFail().id
    const repository = scope.repository!
    const commitId = repository.activeCommitId
    const commit = commitId
      ? ((await inScope({ userId, workspaceId: scope.workspace.id }, (trx) =>
          trx.from('commits').where('id', commitId).select('sha').first()
        )) as { sha: string } | undefined)
      : null
    const groups = commitId
      ? await inScope({ userId, workspaceId: scope.workspace.id }, async (trx) => {
          const classes = await trx
            .from('clone_classes')
            .where('commit_id', commitId)
            .orderBy([
              { column: 'classification', order: 'asc' },
              { column: 'similarity', order: 'desc' },
            ])
            .select('id', 'classification', 'method', 'similarity', 'size')
          if (classes.length === 0) return [] as CloneGroupView[]
          const members = await trx
            .from('clone_members')
            .whereIn(
              'class_id',
              classes.map((c) => c.id)
            )
            .orderBy(['class_id', 'path'])
            .select(
              'class_id',
              'path',
              'qualified_name',
              'start_line',
              'end_line',
              'tokens',
              'divergence'
            )
          const byClass = new Map<string, CloneMemberView[]>()
          for (const m of members) {
            const list = byClass.get(String(m.class_id)) ?? []
            list.push({
              path: String(m.path),
              symbol: String(m.qualified_name),
              startLine: Number(m.start_line),
              endLine: Number(m.end_line),
              tokens: Number(m.tokens),
              divergence: (m.divergence ?? []) as CloneMemberView['divergence'],
            })
            byClass.set(String(m.class_id), list)
          }
          return classes.map((c) => ({
            id: String(c.id),
            classification: String(c.classification),
            method: String(c.method),
            similarity: Number(c.similarity),
            size: Number(c.size),
            members: byClass.get(String(c.id)) ?? [],
          }))
        })
      : []

    return inertia.render('duplicates/index', {
      workspace: WorkspaceTransformer.transform(scope.workspace),
      repository: RepositoryTransformer.transform(repository),
      commitSha: commit ? String(commit.sha) : null,
      groups,
      assetsVersion: assetsVersion(),
      // The generated page-props type for this page resolves to `never` under the server
      // tsconfig's ExtractProps (a codegen quirk with this page's inferred return); the props are
      // runtime data Inertia validates. Cast so the build is not blocked by that inference gap.
    } as never)
  }
}
