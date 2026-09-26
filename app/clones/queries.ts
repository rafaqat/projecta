import { inScope, type Scope } from '#app/security/scope'

/**
 * Similarity queries. Every query runs in the caller's
 * scoped transaction: row-level security restricts `clone_signatures` to
 * the workspace, and the join through `commits` to `repositories` — itself
 * under the ACL policy — drops restricted repositories the actor is not a
 * member of. Only active commits are searched.
 */
export interface SimilarSymbol {
  workspaceId: string
  repositoryId: string
  repositoryName: string
  commitSha: string
  path: string
  qualifiedName: string
  startLine: number
  endLine: number
  sharedBands: number
}

export interface StoredCloneClass {
  id: string
  type: number
  classification: 'duplicate' | 'pattern'
  method: string
  similarity: number
  members: Array<{
    path: string
    qualifiedName: string
    startLine: number
    endLine: number
    divergence: Array<{ start: number; end: number }>
  }>
}

const MAX_RESULTS = 20

export async function similarSymbols(
  scope: Scope,
  commitId: string,
  path: string,
  qualifiedName: string
): Promise<SimilarSymbol[]> {
  return inScope(scope, async (trx) => {
    const rows = await trx.rawQuery(
      `with mine as (
         select band from clone_signatures
          where commit_id = :commit and path = :path and qualified_name = :name
       )
       select s.workspace_id, r.id as repository_id, r.name as repository_name, c.sha,
              s.path, s.qualified_name, s.start_line, s.end_line, count(*)::int as shared
         from clone_signatures s
         join mine on mine.band = s.band
         join commits c on c.id = s.commit_id
         join repositories r on r.id = c.repository_id and r.active_commit_id = c.id
        where not (s.commit_id = :commit and s.path = :path and s.qualified_name = :name)
        group by s.workspace_id, r.id, r.name, c.sha, s.path, s.qualified_name, s.start_line, s.end_line
        order by shared desc, r.name, s.path, s.qualified_name
        limit :limit`,
      { commit: commitId, path, name: qualifiedName, limit: MAX_RESULTS }
    )
    return rows.rows.map((r: Record<string, any>) => ({
      workspaceId: r.workspace_id,
      repositoryId: r.repository_id,
      repositoryName: r.repository_name,
      commitSha: r.sha,
      path: r.path,
      qualifiedName: r.qualified_name,
      startLine: r.start_line,
      endLine: r.end_line,
      sharedBands: r.shared,
    }))
  })
}

/** Clone classes of one commit, duplicates first, inconsistent near misses at the top. */
export async function cloneClasses(scope: Scope, commitId: string): Promise<StoredCloneClass[]> {
  return inScope(scope, async (trx) => {
    const classes = await trx
      .from('clone_classes')
      .where('commit_id', commitId)
      .orderByRaw(`classification = 'duplicate' desc, type desc, size desc`)
      .limit(MAX_RESULTS)
    const members = classes.length
      ? await trx
          .from('clone_members')
          .whereIn(
            'class_id',
            classes.map((c) => c.id)
          )
          .orderBy(['path', 'start_line'])
      : []
    return classes.map((c) => ({
      id: c.id,
      type: c.type,
      classification: c.classification,
      method: c.method,
      similarity: c.similarity,
      members: members
        .filter((m) => m.class_id === c.id)
        .map((m) => ({
          path: m.path,
          qualifiedName: m.qualified_name,
          startLine: m.start_line,
          endLine: m.end_line,
          divergence: m.divergence,
        })),
    }))
  })
}
