import { defaultEmbedder } from '#app/parse/embedder'
import { scopePolicy } from '#app/retrieval/router'
import { byScoreThenPosition, searchLexical, searchVector, type Hit } from '#app/retrieval/search'
import { inScope, type Scope } from '#app/security/scope'
import { isAblated } from '#app/security/ablation_switch'
import { exactMatchBonus, exactTerms } from '#app/retrieval/rerank'
import { lexicalQuery } from '#app/retrieval/search_text'
import { withLexicalFallback } from '#app/retrieval/lexical_fallback'

/**
 * Hybrid search (design §5): exact kNN, BM25 over
 * search_text and BM25 over symbol names, fused with reciprocal rank fusion
 * (k = 60), then diversity caps and a context budget. Every result carries
 * completeness metadata; below the sufficiency threshold the tool returns
 * `insufficient_evidence` and the absence protocol takes over.
 */
export const RRF_K = 60

export interface RetrievedChunk extends Hit {
  symbolName: string | null
  fused: number
}

export interface RetrievalResult {
  status: 'ok' | 'insufficient_evidence'
  chunks: RetrievedChunk[]
  shown: number
  total: number
  truncated: boolean
  queriesRun: string[]
  excludedPaths: string[]
}

export function reciprocalRankFusion(
  lists: Array<Array<{ id: string }>>,
  k = RRF_K
): Map<string, number> {
  const scores = new Map<string, number>()
  for (const list of lists) {
    list.forEach((item, rank) =>
      scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + rank + 1))
    )
  }
  return scores
}

const EXCLUDED_PATTERNS = [
  /(^|\/)node_modules\//,
  /\.(lock|min\.js|map)$/,
  /(^|\/)dist\//,
  /(^|\/)build\//,
]

/** Test files are limited unless the question is about tests. */
function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[jt]sx?$/.test(path)
}

export async function retrieve(
  scope: Scope,
  commitId: string,
  question: string,
  options: { symbolNames?: boolean; sufficiencyMinScore?: number; exactMatchBonus?: number } = {}
): Promise<RetrievalResult> {
  const budgets = scopePolicy().budgets
  const sufficiencyMinScore = options.sufficiencyMinScore ?? budgets.sufficiencyMinScore
  const bonus = options.exactMatchBonus ?? budgets.exactMatchBonus ?? 0
  const k = budgets.candidatesPerRetriever
  const queriesRun: string[] = []

  const embedder = await defaultEmbedder()
  const [vector] = await embedder.embed([question])
  const vectorHits = await searchVector(scope, commitId, vector, k)
  queriesRun.push(`vector:${embedder.id}`)
  const lexicalHits = await searchLexical(scope, commitId, question, k)
  queriesRun.push(`bm25:search_text`)
  const symbolHits =
    options.symbolNames === false ? [] : await symbolNameHits(scope, commitId, question, k)
  queriesRun.push(`bm25:symbol_names`)

  const byId = new Map<string, Hit & { symbolName: string | null }>()
  for (const hit of [...vectorHits, ...lexicalHits, ...symbolHits]) {
    if (!byId.has(hit.id))
      byId.set(hit.id, { ...hit, symbolName: (hit as { symbolName?: string }).symbolName ?? null })
  }
  const fused = reciprocalRankFusion([vectorHits, lexicalHits, symbolHits])
  // A chunk that contains the question's exact identifiers, routes or file names outranks one
  // that only matches semantically: one first-rank vote per distinct term.
  const terms = bonus > 0 ? exactTerms(question) : []
  const ranked = Array.from(fused.entries())
    .map(([id, score]) => {
      const hit = byId.get(id)!
      return { ...hit, fused: score + (terms.length ? exactMatchBonus(terms, hit, bonus) : 0) }
    })
    .sort((a, b) => byScoreThenPosition({ ...a, score: a.fused }, { ...b, score: b.fused }))

  const aboutTests = /\btests?\b|\bspec\b/i.test(question)
  // T-08 mitigations, each removable under its ablation so the suite can prove it does something
  // (tests/functional/redteam/rank_poison_ablations.spec.ts).
  const diversityCaps = !(await isAblated('no_diversity_caps'))
  const sufficiencyGate = !(await isAblated('no_sufficiency_gate'))
  const perFile = new Map<string, number>()
  const seenSymbols = new Set<string>()
  const excludedPaths = new Set<string>()
  const kept: RetrievedChunk[] = []
  for (const chunk of ranked) {
    if (chunk.source === 'honeytoken') {
      kept.push(chunk)
      continue
    }
    if (
      EXCLUDED_PATTERNS.some((p) => p.test(chunk.path)) ||
      (isTestPath(chunk.path) && !aboutTests)
    ) {
      excludedPaths.add(chunk.path)
      continue
    }
    const symbolKey = chunk.symbolName ? `${chunk.path}#${chunk.symbolName}` : null
    if (diversityCaps && symbolKey && seenSymbols.has(symbolKey)) continue
    const count = perFile.get(chunk.path) ?? 0
    if (diversityCaps && count >= budgets.maxChunksPerFile) continue
    perFile.set(chunk.path, count + 1)
    if (symbolKey) seenSymbols.add(symbolKey)
    kept.push(chunk)
  }

  const shown = kept.slice(0, budgets.contextChunks)
  const best = shown[0]?.fused ?? 0
  const insufficient = shown.length === 0 || (sufficiencyGate && best < sufficiencyMinScore)
  const status = insufficient ? 'insufficient_evidence' : 'ok'
  return {
    status,
    chunks: shown,
    shown: shown.length,
    total: kept.length,
    truncated: kept.length > shown.length,
    queriesRun,
    excludedPaths: Array.from(excludedPaths).sort(),
  }
}

/** Chunks of the symbols whose names the question's terms match; only matches, whichever plan runs (see searchLexical). */
export async function symbolNameHits(
  scope: Scope,
  commitId: string,
  question: string,
  k: number
): Promise<Array<Hit & { symbolName: string }>> {
  const terms = lexicalQuery(question)
  // No terms means no symbol-name match; skip rather than pass an empty query to the BM25 extension.
  if (!terms) return []
  const query = () =>
    inScope(scope, async (trx) => {
      const rows = await trx.rawQuery(
        `select c.id, c.path, c.start_line, c.end_line, c.text, c.workspace_id, s.qualified_name,
              -(s.qualified_name <@> to_bm25query(:terms, 'symbols_name_bm25')) as score
         from symbols s join chunks c on c.symbol_id = s.id
        where s.commit_id = :commit and s.kind not in ('region', 'import')
          and (s.qualified_name <@> to_bm25query(:terms, 'symbols_name_bm25')) < 0
        order by s.qualified_name <@> to_bm25query(:terms, 'symbols_name_bm25'), c.path, c.start_line, c.id
        limit :k`,
        { terms, commit: commitId, k }
      )
      return rows.rows.map((r: Record<string, unknown>) => ({
        source: 'chunk' as const,
        id: String(r.id),
        path: String(r.path),
        startLine: Number(r.start_line),
        endLine: Number(r.end_line),
        text: String(r.text),
        score: Number(r.score),
        workspaceId: String(r.workspace_id),
        symbolName: String(r.qualified_name),
      }))
    })
  // The symbol-name retriever is only a booster (its symbols' chunks are also found by content in
  // searchLexical), and there is no tsvector column on symbols, so on a BM25 fault degrade to none
  // rather than fail the turn — reported, not swallowed.
  return withLexicalFallback('symbolNameHits', query, async () => [])
}
