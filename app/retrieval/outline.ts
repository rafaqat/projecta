import { inScope, type Scope } from '#app/security/scope'

/**
 * The outline of a file at a commit: its declarations from the symbols
 * table, in line order, and its chunks in line order — what a question
 * anchored on a path is answered from (UAT 2026-09-15: addProduct.js was
 * described from three fragments and five searches; the file was in the
 * index the whole time). Resolved from the index, never from a search: a
 * bare basename names the file it belongs to, an unknown path says so.
 */
export interface OutlineSymbol {
  kind: string
  name: string
  qualifiedName: string
  startLine: number
  endLine: number
}

export interface FileOutline {
  /** The path as resolved at the commit; the question's spelling when nothing matched. */
  path: string
  exists: boolean
  /** Lines of the file, from its content; 0 when unknown. */
  lines: number
  symbols: OutlineSymbol[]
  /** The file's chunks in line order: the evidence a description cites. */
  chunkIds: string[]
}

const NOT_DECLARATIONS = new Set(['region', 'import'])

export async function fileOutline(
  scope: Scope,
  commitId: string,
  named: string
): Promise<FileOutline> {
  const spelled = named.trim().replace(/^\.?\//, '')
  return inScope(scope, async (trx) => {
    const file = await trx
      .from('files')
      .join('blobs', 'blobs.blob_sha', 'files.blob_sha')
      .where('files.commit_id', commitId)
      .whereNull('files.ignored_by')
      .where((q) => q.where('files.path', spelled).orWhereLike('files.path', `%/${spelled}`))
      .orderByRaw('case when files.path = ? then 0 else 1 end, files.path', [spelled])
      .select('files.path', 'blobs.content')
      .first()
    if (!file) return { path: spelled, exists: false, lines: 0, symbols: [], chunkIds: [] }
    const path = String(file.path)
    const content = file.content === null ? '' : String(file.content)
    const lines = content ? content.split('\n').length : 0
    const symbols = await trx
      .from('symbols')
      .where({ commit_id: commitId, path })
      .whereNotIn('kind', [...NOT_DECLARATIONS])
      .orderBy(['start_line', 'end_line', 'qualified_name'])
      .select('kind', 'name', 'qualified_name', 'start_line', 'end_line')
    const chunks = await trx
      .from('chunks')
      .where({ commit_id: commitId, path })
      .orderBy(['start_line', 'end_line'])
      .select('id')
    return {
      path,
      exists: true,
      lines,
      symbols: symbols.map((s) => ({
        kind: String(s.kind),
        name: String(s.name),
        qualifiedName: String(s.qualified_name),
        startLine: Number(s.start_line),
        endLine: Number(s.end_line),
      })),
      chunkIds: chunks.map((c) => String(c.id)),
    }
  })
}
