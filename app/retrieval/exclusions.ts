import { MODE_GITLINK, MODE_SYMLINK } from '#app/ingest/object_reader'
import { grammarFor } from '#app/parse/parser'
import { inScope, type Scope } from '#app/security/scope'

/**
 * What the index left out of a commit, and why (WP-19, BL-23). Every
 * exclusion is named from stored facts: the blob's skip reason, the file
 * mode, or the absence of a grammar for the path. An absence answer names
 * the exclusions the question points at, so a wrong "not found" is never
 * silent about content the reader can see in the repository.
 */
export type ExclusionReason =
  | 'binary'
  | 'line_too_long'
  | 'file_too_large'
  | 'unsupported_language'
  | 'symlink'
  | 'submodule'
  /** Matched an ignore pattern (UAT 2026-09-14); the pattern follows after a colon. */
  | 'ignored_path'
  | string

export interface Exclusion {
  path: string
  reason: ExclusionReason
}

export async function exclusionsFor(scope: Scope, commitId: string): Promise<Exclusion[]> {
  const rows = await inScope(scope, (trx) =>
    trx
      .from('files')
      .leftJoin('blobs', (join) =>
        join
          .on('blobs.blob_sha', 'files.blob_sha')
          .andOn('blobs.workspace_id', 'files.workspace_id')
      )
      .where('files.commit_id', commitId)
      .select('files.path', 'files.mode', 'files.ignored_by', 'blobs.skip_reason')
      .orderBy('files.path')
  )
  const out: Exclusion[] = []
  for (const row of rows as Array<{
    path: string
    mode: string
    ignored_by: string | null
    skip_reason: string | null
  }>) {
    if (row.ignored_by) out.push({ path: row.path, reason: `ignored_path:${row.ignored_by}` })
    else if (row.mode === MODE_GITLINK) out.push({ path: row.path, reason: 'submodule' })
    else if (row.mode === MODE_SYMLINK) out.push({ path: row.path, reason: 'symlink' })
    else if (row.skip_reason) out.push({ path: row.path, reason: row.skip_reason })
    else if (!grammarFor(row.path)) out.push({ path: row.path, reason: 'unsupported_language' })
  }
  return out
}

/** The exclusions a question points at: it names the path, its file name, or its stem. */
export function exclusionsNamedBy(question: string, exclusions: Exclusion[]): Exclusion[] {
  const q = question.toLowerCase()
  const words = new Set(q.match(/[a-z0-9_.-]+/g) ?? [])
  return exclusions.filter(({ path }) => {
    const lower = path.toLowerCase()
    const base = lower.split('/').pop()!
    const stem = base.replace(/\.[^.]+$/, '')
    return q.includes(lower) || words.has(base) || (stem.length > 2 && words.has(stem))
  })
}
