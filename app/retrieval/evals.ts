import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { retrieve } from '#app/retrieval/hybrid'
import { inScope, type Scope } from '#app/security/scope'

/**
 * Retrieval-only evaluation (design §11): recall@k and MRR at
 * symbol level over human-labelled cases. Cases without `labelled_by` are
 * reported and skipped, never scored (GC-04).
 */
export interface EvalCase {
  id: string
  question: string
  expectedSymbols: string[]
  tags?: string[]
}

export interface EvalFile {
  fixture: string
  commit: string | null
  labelled_by: string | null
  cases: EvalCase[]
}

export interface EvalReport {
  split: string
  files: number
  labelledCases: number
  skippedUnlabelled: number
  recallAt10: number | null
  mrr: number | null
  perCase: Array<{ id: string; recall: number; reciprocalRank: number }>
}

export async function loadEvalFiles(split: string): Promise<EvalFile[]> {
  const dir = join('evals', 'cases', split)
  const entries = await readdir(dir).catch(() => [] as string[])
  const names = entries.filter((n) => n.endsWith('.json'))
  const files: EvalFile[] = []
  for (const name of names)
    files.push(JSON.parse(await readFile(join(dir, name), 'utf8')) as EvalFile)
  return files
}

interface FoundSymbol {
  symbol: string
  path: string
}

/** An expected entry containing "/" is a path: any symbol in that file satisfies it. */
function satisfies(expected: string, hit: FoundSymbol): boolean {
  return expected.includes('/') ? hit.path === expected : hit.symbol === expected
}

export async function runRetrievalEval(
  split: string,
  scope: Scope,
  commitId: string,
  commitSha: string,
  k = 10,
  /** Retrieval options for a sweep; the policy's values by default. */
  options: { exactMatchBonus?: number } = {}
): Promise<EvalReport> {
  const files = await loadEvalFiles(split)
  const report: EvalReport = {
    split,
    files: files.length,
    labelledCases: 0,
    skippedUnlabelled: 0,
    recallAt10: null,
    mrr: null,
    perCase: [],
  }
  for (const file of files) {
    if (!file.labelled_by) {
      report.skippedUnlabelled += file.cases.length
      continue
    }
    // Labels are pinned to the commit they were made against (design §11).
    if (file.commit && file.commit !== commitSha) {
      throw new Error(
        `${file.fixture}: cases pinned to ${file.commit.slice(0, 7)} but the active commit is ${commitSha.slice(0, 7)}`
      )
    }
    for (const c of file.cases) {
      const result = await retrieve(scope, commitId, c.question, options)
      const symbols = await symbolsFor(
        scope,
        result.chunks.map((h) => h.id)
      )
      const found = symbols.slice(0, k)
      const satisfied = c.expectedSymbols.filter((e) => found.some((hit) => satisfies(e, hit)))
      const recall = c.expectedSymbols.length ? satisfied.length / c.expectedSymbols.length : 0
      const firstRank = found.findIndex((hit) => c.expectedSymbols.some((e) => satisfies(e, hit)))
      report.perCase.push({
        id: c.id,
        recall,
        reciprocalRank: firstRank === -1 ? 0 : 1 / (firstRank + 1),
      })
      report.labelledCases++
    }
  }
  if (report.labelledCases > 0) {
    report.recallAt10 = report.perCase.reduce((s, c) => s + c.recall, 0) / report.labelledCases
    report.mrr = report.perCase.reduce((s, c) => s + c.reciprocalRank, 0) / report.labelledCases
  }
  return report
}

async function symbolsFor(scope: Scope, chunkIds: string[]): Promise<FoundSymbol[]> {
  if (chunkIds.length === 0) return []
  const rows = await inScope(scope, (trx) =>
    trx
      .from('chunks')
      .join('symbols', 'symbols.id', 'chunks.symbol_id')
      .whereIn('chunks.id', chunkIds)
      .select('chunks.id', 'chunks.path', 'symbols.qualified_name')
  )
  const byId = new Map<string, FoundSymbol>(
    rows.map((r) => [r.id, { symbol: r.qualified_name, path: r.path }])
  )
  return chunkIds.map((id) => byId.get(id)).filter((s): s is FoundSymbol => Boolean(s))
}

/** Markdown for the CI job summary. */
export function renderEvalSummary(report: EvalReport): string {
  const value = (v: number | null) => (v === null ? 'n/a (no labelled cases)' : v.toFixed(3))
  return [
    `## Retrieval evals (${report.split})`,
    '',
    '| Metric | Value |',
    '|---|---|',
    `| recall@10 | ${value(report.recallAt10)} |`,
    `| MRR | ${value(report.mrr)} |`,
    `| labelled cases | ${report.labelledCases} |`,
    `| skipped (unlabelled) | ${report.skippedUnlabelled} |`,
    '',
  ].join('\n')
}
