import { codeEntities } from '#app/assistant/verification'

/**
 * Exact name matches outrank semantic matches. The question's code entities, route
 * paths and file names are its exact terms; a chunk that contains a term as a whole token — an
 * identifier in its text or symbol name, a route path verbatim, a file name equal to its path or
 * base name — gains one first-rank vote (1 / (k + 1)) per distinct term on top of its fused score.
 */
/** One first-rank vote in one retriever: 1 / (RRF k + 1), k = 60 as in hybrid.ts. */
export const EXACT_MATCH_BONUS = 1 / 61

const ROUTE =
  /\b(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+)?(\/[\w\-/:.{}]*[\w\-:}]|\/)(?=[\s`'"?.,;:!)]|$)/g
const FILE_NAME = /^[\w.\-/]+\.[a-z]{1,5}$/i

export function exactTerms(question: string): string[] {
  const routes = [...question.matchAll(ROUTE)]
    .filter((m) => m[2].length > 1)
    .map((m) => (m[1] ? `${m[1].toUpperCase()} ${m[2]}` : m[2]))
  const entities = codeEntities(question).filter(
    (e) => !e.startsWith('/') && !routes.some((r) => r.includes(e))
  )
  return [...new Set([...routes, ...entities])]
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function exactMatchBonus(
  terms: string[],
  chunk: { path: string; text: string; symbolName: string | null },
  bonus = EXACT_MATCH_BONUS
): number {
  let matched = 0
  const lowerPath = chunk.path.toLowerCase()
  const base = lowerPath.slice(lowerPath.lastIndexOf('/') + 1)
  for (const term of terms) {
    const route = /^(?:[A-Z]+ )?\//.test(term)
    if (route) {
      const path = term.replace(/^[A-Z]+ /, '')
      if (chunk.text.toLowerCase().includes(path.toLowerCase())) matched++
      continue
    }
    if (FILE_NAME.test(term) && term.includes('.') && !/^[a-z]+\.[A-Za-z_$][\w$]*$/.test(term)) {
      const t = term.toLowerCase()
      if (lowerPath === t || lowerPath.endsWith(`/${t}`) || base === t) {
        matched++
        continue
      }
    }
    const short = term.replace(/\(\)$/, '').split('.').pop()!
    const whole = new RegExp(`(^|[^\\w$])${escape(short)}(?![\\w$])`)
    if (whole.test(chunk.text) || (chunk.symbolName ? whole.test(chunk.symbolName) : false))
      matched++
  }
  return matched * bonus
}
