import type { Scope } from '#app/security/scope'
import { inScope } from '#app/security/scope'
import { isAblated } from '#app/security/ablation_switch'
import { toVectorLiteral } from '#app/parse/embedder'
import env from '#start/env'
import { lexicalQuery } from '#app/retrieval/search_text'
import { withLexicalFallback } from '#app/retrieval/lexical_fallback'

/**
 * Retrieval primitives (SEC-30). Chunks are read under
 * row-level security for the active commit; honeytokens are a global table
 * joined with the application's own workspace filter. A honeytoken is
 * excluded only when it belongs to the actor's workspace, so if the filter
 * is ever lost (ablation `no_workspace_filter`) foreign tokens surface and
 * the gateway tripwire fires. Rank fusion and routing arrive in WP-05.
 */
export type LexicalBackend = 'pg_textsearch' | 'tsvector'

export interface Hit {
  source: 'chunk' | 'honeytoken'
  id: string
  path: string
  startLine: number
  endLine: number
  text: string
  score: number
  workspaceId: string
}

/**
 * Ties are broken by content position, never by row order (WP-19): a row
 * rewrite must not reorder results, or an eval baseline measures the heap.
 */
export function byScoreThenPosition(
  a: { score: number; path: string; startLine: number; id: string },
  b: { score: number; path: string; startLine: number; id: string }
): number {
  return (
    b.score - a.score ||
    a.path.localeCompare(b.path) ||
    a.startLine - b.startLine ||
    a.id.localeCompare(b.id)
  )
}

export function lexicalBackend(): LexicalBackend {
  return (env.get('LEXICAL_BACKEND') as LexicalBackend | undefined) ?? 'pg_textsearch'
}

export async function searchLexical(
  scope: Scope,
  commitId: string,
  query: string,
  k = 10,
  backend = lexicalBackend()
): Promise<Hit[]> {
  // Split like the index (search_text.ts): `sendPassword` in a question meets `send-password` in code.
  const terms = lexicalQuery(query)
  // No terms means no lexical match; skip the query rather than hand an empty query to the BM25
  // extension (wasteful, and an empty `to_bm25query('')` is a plausible fault trigger).
  if (!terms) return []
  const workspaceFilter = (await isAblated('no_workspace_filter'))
    ? ''
    : 'and h.workspace_id = :workspace'
  const run = (b: LexicalBackend): Promise<Hit[]> =>
    inScope(scope, async (trx) => {
      const chunkOrder =
        b === 'pg_textsearch'
          ? "c.search_text <@> to_bm25query(:terms, 'chunks_search_bm25')"
          : "ts_rank(c.search_tsv, plainto_tsquery('simple', :terms)) desc"
      // Only documents that match: an index scan never returns the rest, a sequential scan scores
      // them at 0, and which plan runs follows the planner's statistics (CI 35011180473, two arms of
      // one corpus: 9 hits against 45). Without the filter the limit admits zero-score chunks that
      // then earn rank credit in the fusion.
      const chunkWhere =
        b === 'pg_textsearch'
          ? "and (c.search_text <@> to_bm25query(:terms, 'chunks_search_bm25')) < 0"
          : "and c.search_tsv @@ plainto_tsquery('simple', :terms)"
      const chunks = await trx.rawQuery(
        `select 'chunk' as source, c.id, c.path, c.start_line, c.end_line, c.text, c.workspace_id,
              ${b === 'pg_textsearch' ? "-(c.search_text <@> to_bm25query(:terms, 'chunks_search_bm25'))" : "ts_rank(c.search_tsv, plainto_tsquery('simple', :terms))"} as score
         from chunks c
        where c.commit_id = :commit ${chunkWhere}
        order by ${chunkOrder}, c.path, c.start_line, c.id
        limit :k`,
        { terms, commit: commitId, k }
      )
      const tokenOrder =
        b === 'pg_textsearch'
          ? "h.search_text <@> to_bm25query(:terms, 'honeytokens_search_bm25')"
          : "ts_rank(h.search_tsv, plainto_tsquery('simple', :terms)) desc"
      const tokenWhere =
        b === 'pg_textsearch'
          ? "and (h.search_text <@> to_bm25query(:terms, 'honeytokens_search_bm25')) < 0"
          : "and h.search_tsv @@ plainto_tsquery('simple', :terms)"
      const tokens = await trx.rawQuery(
        `select 'honeytoken' as source, h.id, 'config/integrations.ts' as path, 1 as start_line, 6 as end_line, h.text, h.workspace_id,
              ${b === 'pg_textsearch' ? "-(h.search_text <@> to_bm25query(:terms, 'honeytokens_search_bm25'))" : "ts_rank(h.search_tsv, plainto_tsquery('simple', :terms))"} as score
         from honeytokens h
        where not (h.workspace_id = :workspace) ${workspaceFilter} ${tokenWhere}
        order by ${tokenOrder}, h.id
        limit :k`,
        { terms, workspace: scope.workspaceId ?? '', k }
      )
      return [...chunks.rows, ...tokens.rows].map(toHit).sort(byScoreThenPosition).slice(0, k)
    })
  // BM25 is the primary; on an index fault (XX*, dropped connection) degrade to the tsvector column
  // maintained on the same content, so one flaky query does not fail the turn (resilience).
  if (backend === 'pg_textsearch') {
    return withLexicalFallback(
      'searchLexical',
      () => run('pg_textsearch'),
      () => run('tsvector')
    )
  }
  return run(backend)
}

export async function searchVector(
  scope: Scope,
  commitId: string,
  vector: Float32Array,
  k = 10
): Promise<Hit[]> {
  const literal = toVectorLiteral(vector)
  const workspaceFilter = (await isAblated('no_workspace_filter'))
    ? ''
    : 'and h.workspace_id = :workspace'
  return inScope(scope, async (trx) => {
    const chunks = await trx.rawQuery(
      `select 'chunk' as source, c.id, c.path, c.start_line, c.end_line, c.text, c.workspace_id, 1 - (c.embedding <=> :vector::halfvec) as score
         from chunks c where c.commit_id = :commit and c.embedding is not null
        order by c.embedding <=> :vector::halfvec, c.path, c.start_line, c.id limit :k`,
      { vector: literal, commit: commitId, k }
    )
    const tokens = await trx.rawQuery(
      `select 'honeytoken' as source, h.id, 'config/integrations.ts' as path, 1 as start_line, 6 as end_line, h.text, h.workspace_id, 1 - (h.embedding <=> :vector::halfvec) as score
         from honeytokens h where not (h.workspace_id = :workspace) ${workspaceFilter}
        order by h.embedding <=> :vector::halfvec, h.id limit :k`,
      { vector: literal, workspace: scope.workspaceId ?? '', k }
    )
    return [...chunks.rows, ...tokens.rows].map(toHit).sort(byScoreThenPosition).slice(0, k)
  })
}

function toHit(row: Record<string, unknown>): Hit {
  return {
    source: row.source as Hit['source'],
    id: String(row.id),
    path: String(row.path),
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    text: String(row.text),
    score: Number(row.score),
    workspaceId: String(row.workspace_id),
  }
}
