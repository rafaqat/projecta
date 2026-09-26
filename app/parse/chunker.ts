import type { ParsedSymbol } from '#app/parse/profiles/node_symbols'

/**
 * cAST chunking (design §4;): one chunk per symbol — a whole function whenever it
 * fits the budget — split along statement-level blocks when it does not, each with a header naming
 * the path and enclosing symbol so the embedded text and the lexical view both carry that context.
 */
export const CHUNKER_VERSION = 'cast-v5'

/**
 * The budget, in weighted characters: 6,000 keeps 97–100% of real functions whole. The
 * embedder reads 2,048 tokens; 6,000 characters of code is ~1,900 of them, and a non-ASCII
 * character — CJK prose is about a token each — weighs three, so a region of Chinese is bounded at
 * ~2,000 characters and its vector stays complete.
 */
export const MAX_CHUNK_CHARS = 6000

export function chunkWeight(text: string): number {
  let weight = 0
  for (const ch of text) weight += ch.charCodeAt(0) < 128 ? 1 : 3
  return weight
}

export interface Chunk {
  symbolIndex: number
  startLine: number
  endLine: number
  header: string
  code: string
}

interface LineRange {
  startLine: number
  endLine: number
}

const chunkable = (s: ParsedSymbol) => s.kind !== 'import' && s.kind !== 'region'
const extent = (s: ParsedSymbol): LineRange => ({
  startLine: s.docStartLine ?? s.startLine,
  endLine: s.endLine,
})
const strictlyInside = (inner: LineRange, outer: LineRange) =>
  inner.startLine >= outer.startLine &&
  inner.endLine <= outer.endLine &&
  (inner.startLine > outer.startLine || inner.endLine < outer.endLine)

/** A line of only brackets and punctuation: `}`, `},`, `});`, `]`. */
const PUNCTUATION_ONLY = /^[\s{}()[\];,]*$/

export function chunkSymbols(path: string, source: string, symbols: ParsedSymbol[]): Chunk[] {
  const lines = source.split('\n')
  const slice = (start: number, end: number) => lines.slice(start - 1, end).join('\n')
  const weightOf = (start: number, end: number) => chunkWeight(slice(start, end))
  const chunks: Chunk[] = []
  symbols.forEach((symbol, symbolIndex) => {
    // An import binding is a name, not code to cite: its lines are chunked as the file region they are.
    if (symbol.kind === 'import') return
    const header = `// path: ${path}\n// symbol: ${symbol.qualifiedName}\n`
    // A span over the budget with no block boundary inside it is cut into line windows — the last
    // resort, for a single line over the budget, which the ingest line limit bounds. Everything
    // with a statement boundary splits on it (: the Node profile hands over the statements
    // inside an over-budget statement, so a 52-line `try` is not one block).
    const push = (start: number, end: number) => {
      let from = start
      while (from <= end) {
        let to = from
        let weight = chunkWeight(lines[from - 1])
        while (to < end && weight + 1 + chunkWeight(lines[to]) <= MAX_CHUNK_CHARS) {
          weight += 1 + chunkWeight(lines[to])
          to++
        }
        chunks.push({ symbolIndex, startLine: from, endLine: to, header, code: slice(from, to) })
        from = to + 1
      }
    }
    // Split a range along the blocks inside it, stretched to tile the range so no line is lost:
    // the first block reaches back to the range's start (the signature), each takes the lines
    // since the block before it (a comment above a statement rides with that statement), and the
    // last runs on to the range's end (the closing brace). 533 of 953 split symbols of one real
    // repository were missing their `}` before this (owner, reading cited spans, 2026-09-20).
    const split = (range: LineRange, blocks: LineRange[]) => {
      const inside = blocks.filter(
        (b) => b.endLine >= range.startLine && b.startLine <= range.endLine
      )
      if (weightOf(range.startLine, range.endLine) <= MAX_CHUNK_CHARS || inside.length <= 1) {
        push(range.startLine, range.endLine)
        return
      }
      const last = inside.length - 1
      const spans = inside.map((block, i) => ({
        start:
          i === 0
            ? Math.min(range.startLine, block.startLine)
            : Math.min(block.startLine, inside[i - 1].endLine + 1),
        end: i === last ? Math.max(range.endLine, block.endLine) : block.endLine,
      }))
      let start = spans[0].start
      let end = start - 1
      for (const span of spans) {
        if (weightOf(start, span.end) > MAX_CHUNK_CHARS && end >= start) {
          push(start, end)
          start = span.start
        }
        end = span.end
      }
      if (end >= start) push(start, end)
    }

    const own = extent(symbol)
    // A container never re-chunks what its children cover. A class of methods, an
    // object literal of handlers, a Swift or Kotlin type: its children are symbols with chunks of
    // their own, and cutting the container into line windows on top of them indexed the same
    // code twice (20.8% of StyleSwap's lines; 55% of swift-argument-parser's) with windows that
    // began at `} catch (error) {`. Only the container's own lines can form a chunk, and only when
    // they hold more than its first line, its last line and punctuation.
    const children = symbols.filter(
      (other) => other !== symbol && chunkable(other) && strictlyInside(extent(other), own)
    )
    if (children.length === 0) {
      split(own, symbol.blocks)
      return
    }
    const covered = new Set<number>()
    for (const child of children)
      for (let line = child.docStartLine ?? child.startLine; line <= child.endLine; line++)
        covered.add(line)
    let runStart: number | null = null
    const runs: LineRange[] = []
    for (let line = own.startLine; line <= own.endLine + 1; line++) {
      const free = line <= own.endLine && !covered.has(line)
      if (free) runStart ??= line
      else if (runStart !== null) {
        runs.push({ startLine: runStart, endLine: line - 1 })
        runStart = null
      }
    }
    for (const run of runs) {
      const holdsContent = lines
        .slice(run.startLine - 1, run.endLine)
        .some(
          (text, i) =>
            text.trim().length > 0 &&
            !PUNCTUATION_ONLY.test(text) &&
            run.startLine + i !== own.startLine &&
            run.startLine + i !== own.endLine
        )
      if (!holdsContent) continue
      // Blank edges belong to no one: the run is trimmed to its content.
      let start = run.startLine
      let end = run.endLine
      while (start < end && !lines[start - 1].trim()) start++
      while (end > start && !lines[end - 1].trim()) end--
      split({ startLine: start, endLine: end }, symbol.blocks)
    }
  })
  return chunks
}
