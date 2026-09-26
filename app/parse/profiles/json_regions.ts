import { mergeRegions } from '#app/parse/profiles/merge_regions'
import type { CitationBlock, ParsedSymbol } from '#app/parse/profiles/node_symbols'

/**
 * JSON without a grammar (WP-19): every top-level key of an object is a
 * symbol spanning its entry's lines, each line a citation block, so locale
 * strings, manifests and configuration can be cited and verified like code.
 * A non-object root is one file region. The scanner tracks strings and
 * escapes so braces or colons inside values never open an entry.
 */
export function extractJsonSymbols(content: string): ParsedSymbol[] {
  // Consecutive small entries are one region: a locale file is a key per line, and was
  // a chunk per line — 886 chunks for 887 lines.
  return mergeRegions(extractJsonEntries(content), content.split('\n'))
}

/** One region per top-level key, before any merging — what the entries of the file are. */
export function extractJsonEntries(content: string): ParsedSymbol[] {
  const lineAt = lineIndex(content)
  const symbols: ParsedSymbol[] = []
  let depth = 0
  let inString = false
  let escaped = false
  let rootIsObject: boolean | null = null
  let key: { name: string; start: number } | null = null
  let stringStart = -1
  let lastString: { text: string; start: number } | null = null

  const close = (end: number) => {
    if (!key) return
    const startLine = lineAt(key.start)
    const endLine = lineAt(end)
    // A chunking unit, not a declaration: regions never enter the golden symbol manifests.
    symbols.push({
      kind: 'region',
      name: key.name,
      qualifiedName: key.name,
      parent: null,
      startLine,
      endLine,
      blocks: lineBlocks(startLine, endLine),
    })
    key = null
  }

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') {
        inString = false
        lastString = { text: content.slice(stringStart + 1, i), start: stringStart }
      }
      continue
    }
    if (ch === '"') {
      inString = true
      stringStart = i
      continue
    }
    if (rootIsObject === null && !/\s/.test(ch)) rootIsObject = ch === '{'
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      if (depth === 1 && rootIsObject) close(lastNonSpace(content, i - 1))
      depth--
    } else if (ch === ':' && depth === 1 && rootIsObject && !key && lastString) {
      key = { name: unescapeKey(lastString.text), start: lastString.start }
    } else if (ch === ',' && depth === 1 && rootIsObject) {
      close(lastNonSpace(content, i - 1))
    }
  }
  if (!rootIsObject && content.trim().length > 0) {
    const startLine = lineAt(content.search(/\S/))
    const endLine = lineAt(lastNonSpace(content, content.length - 1))
    symbols.push({
      kind: 'region',
      name: 'region-1',
      qualifiedName: '<file>#1',
      parent: null,
      startLine,
      endLine,
      blocks: lineBlocks(startLine, endLine),
    })
  }
  return symbols
}

function lineBlocks(startLine: number, endLine: number): CitationBlock[] {
  const blocks: CitationBlock[] = []
  for (let line = startLine; line <= endLine; line++)
    blocks.push({ startLine: line, endLine: line })
  return blocks
}

function lastNonSpace(content: string, from: number): number {
  let i = from
  while (i > 0 && /\s/.test(content[i])) i--
  return i
}

function unescapeKey(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return raw
  }
}

/** Offset → 1-based line, in O(log n) per lookup. */
function lineIndex(content: string): (offset: number) => number {
  const starts = [0]
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') starts.push(i + 1)
  return (offset) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}
