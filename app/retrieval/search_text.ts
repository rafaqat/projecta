/**
 * `search_text` (design §4): the lexical view of a chunk. Every
 * identifier appears whole and split into subtokens, plus path segments and
 * symbol names, so BM25 over `text_config='simple'` matches the way people
 * name things in questions ("user by id", "http server").
 */
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$-]*/g

export function splitIdentifier(identifier: string): string[] {
  const whole = identifier.toLowerCase()
  const parts = identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((p) => p.toLowerCase())
    .filter((p) => p.length > 0)
  const unique = parts.length > 1 || parts[0] !== whole ? [whole, ...parts] : [whole]
  return Array.from(new Set(unique))
}

export interface SearchTextInput {
  path: string
  symbol?: string | null
  code: string
}

export function buildSearchText(input: SearchTextInput): string {
  const tokens = new Set<string>()
  const add = (identifier: string) => {
    for (const token of splitIdentifier(identifier)) tokens.add(token)
  }
  for (const segment of input.path.split('/')) {
    const stem = segment.replace(/\.[A-Za-z0-9]+$/, '')
    if (stem) add(stem)
  }
  if (input.symbol) for (const part of input.symbol.split('.')) add(part)
  for (const match of input.code.matchAll(IDENTIFIER)) {
    if (match[0].length > 1) add(match[0])
  }
  return Array.from(tokens).join(' ')
}

/**
 * The question as a lexical query, split the way the index is (amended 2026-09-17): an
 * identifier in the question contributes its whole token and its subtokens, so `sendPassword`,
 * `send-password` and `send_password` meet on `send password` while the whole token still earns
 * its own weight for an exact spelling. Plain words pass through unchanged.
 */
export function lexicalQuery(question: string): string {
  const out: string[] = []
  for (const token of question.split(/\s+/)) {
    const bare = token.replace(/^[`'"(]+|[`'".,;:!?)]+$/g, '')
    if (!bare) continue
    const parts = bare.split('.').filter(Boolean)
    const expanded = parts.flatMap((p) => splitIdentifier(p))
    if (expanded.length === 0) continue
    out.push(...(parts.length > 1 || expanded.length > 1 ? expanded : [expanded[0]]))
  }
  return out.join(' ')
}
