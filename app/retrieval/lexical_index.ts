import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

/**
 * One BM25 index per workspace (ADR-022).
 *
 * A BM25 score is not computed from the scored row alone: inverse document frequency counts the
 * documents in the index. One index shared by every workspace therefore ranks a tenant's rows using
 * its neighbours' corpora — measured on this schema as a tenant's own two files swapping order, and
 * one of them falling from 0.693147 to 0.038912, when another workspace indexed forty documents it
 * could not read. Row-level security cannot reach this: it filters rows a query returns, while the
 * counts live inside the index and are maintained by writers.
 *
 * So the index is partial, one per workspace, and each carries its own corpus. `honeytokens` keeps a
 * single shared index on purpose: it is the cross-workspace sensor (SEC-30), and its query reads
 * `where not (workspace_id = :workspace)` precisely to see a foreign token.
 */

/** The index name carries the workspace id, so the id is validated before it reaches any SQL. */
const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface LexicalIndexNames {
  chunks: string
  symbols: string
}

/**
 * The names of a workspace's lexical indexes. `to_bm25query(terms, '<index>')` takes the index as a
 * literal, not a bound parameter, so a name reaches SQL by interpolation: it is derived here from a
 * validated UUID and nowhere else, and the hex form keeps both names inside the 63-byte identifier
 * limit (19 + 32 and 18 + 32).
 */
export function lexicalIndexNames(workspaceId: string): LexicalIndexNames {
  if (!WORKSPACE_ID.test(workspaceId)) {
    throw new Error('lexical index: the workspace id is not a UUID')
  }
  const suffix = workspaceId.replace(/-/g, '').toLowerCase()
  return { chunks: `chunks_search_bm25_${suffix}`, symbols: `symbols_name_bm25_${suffix}` }
}

/**
 * Create a workspace's lexical indexes if they are absent. Idempotent and called from the paths that
 * put rows in front of the retriever: the index step, which runs before a workspace's first chunk
 * exists. A workspace that has never ingested has no index and no rows, and its lexical query is
 * answered from the tsvector column (42704, see lexical_fallback). `CREATE INDEX IF NOT EXISTS`
 * costs one catalogue lookup once they exist.
 */
export async function ensureLexicalIndexes(
  trx: TransactionClientContract,
  workspaceId: string
): Promise<void> {
  // The statement lives in `ensure_lexical_indexes` (migration 1790700000001), not here: `CREATE
  // INDEX` accepts no bind parameters and an index name is an identifier, so composing it in
  // TypeScript would put a workspace id into query text (SEC-31). The function quotes both with
  // `format('%I', ...)` and `%L`, and this is an ordinary call with the id bound.
  await trx.rawQuery('select ensure_lexical_indexes(?)', [workspaceId])
}
