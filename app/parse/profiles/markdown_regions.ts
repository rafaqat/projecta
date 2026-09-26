import { mergeRegions } from '#app/parse/profiles/merge_regions'
import type { CitationBlock, ParsedSymbol } from '#app/parse/profiles/node_symbols'

/**
 * Prose without a grammar: README and docs are what "what does this
 * repository do" is answered from (UAT 2026-09-16). Each heading section is
 * a region named by its heading path (`Components.MUButton`), each
 * paragraph or fenced block a citation block; text before the first heading
 * is a region named by the document title, or `<file>#1` when there is
 * none. Fences are skipped for headings, so a `#` inside code never opens
 * a section. Never parsed by tree-sitter.
 */
const ATX = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const SETEXT = /^(=+|-+)\s*$/
const FENCE = /^(```|~~~)/

interface Section {
  level: number
  title: string
  startLine: number
  endLine: number
}

/**
 * The file's symbols: its heading sections (`extractMarkdownSections`), with consecutive small
 * ones packed up to the chunk budget so a changelog's chunk count follows its size and
 * not its heading count.
 */
export function extractMarkdownSymbols(content: string): ParsedSymbol[] {
  return mergeRegions(extractMarkdownSections(content), content.split('\n'))
}

/** One region per heading section, before any merging — what the headings of the file are. */
export function extractMarkdownSections(content: string): ParsedSymbol[] {
  const lines = content.split('\n')
  const sections: Section[] = []
  let fence = false
  let current: Section | null = null
  const open = (level: number, title: string, startLine: number) => {
    if (current) current.endLine = startLine - 1
    current = { level, title: title.trim(), startLine, endLine: lines.length }
    sections.push(current)
  }
  // YAML front matter (a leading `---` block) is metadata, not Markdown: its closing `---` would
  // otherwise read as a setext underline and turn the line above it into a heading — a
  // 594-character `description:` line did, and failed an ingest (WP-24, agent-skills). It stays
  // in the preamble region, so it is still citable text.
  const frontMatterEnd =
    lines[0]?.trim() === '---'
      ? lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l))
      : -1
  for (let i = frontMatterEnd + 1; i < lines.length; i++) {
    const line = lines[i]
    if (FENCE.test(line)) {
      fence = !fence
      continue
    }
    if (fence) continue
    const atx = line.match(ATX)
    if (atx) {
      open(atx[1].length, atx[2], i + 1)
      continue
    }
    // Setext: a title line followed by === (level 1) or --- (level 2), both outside a fence.
    if (i + 1 < lines.length && SETEXT.test(lines[i + 1]) && line.trim() && !ATX.test(line)) {
      open(lines[i + 1].trim().startsWith('=') ? 1 : 2, line, i + 1)
      i++
    }
  }
  // Trim trailing blank lines from every section's span.
  for (const s of sections)
    while (s.endLine > s.startLine && !lines[s.endLine - 1].trim()) s.endLine--

  const symbols: ParsedSymbol[] = []
  const firstHeading = sections[0]?.startLine ?? lines.length + 1
  const preambleEnd = lastNonBlank(lines, 1, firstHeading - 1)
  if (preambleEnd >= 1) {
    symbols.push({
      kind: 'region',
      name: 'preamble',
      qualifiedName: '<file>#1',
      parent: null,
      startLine: firstNonBlank(lines, 1, preambleEnd),
      endLine: preambleEnd,
      blocks: paragraphs(lines, firstNonBlank(lines, 1, preambleEnd), preambleEnd),
    })
  }
  // A document with one level-1 heading uses it as its title, not as a path segment:
  // `Components.MUButton`, not `Sejima.Components.MUButton`.
  const singleTitle = sections.filter((x) => x.level === 1).length === 1
  const path: string[] = []
  for (const s of sections) {
    path.splice(s.level - 1)
    path[s.level - 1] = s.title
    const segments = path.filter(Boolean)
    const qualifiedName =
      singleTitle && s.level > 1 && sections[0].level === 1
        ? segments.slice(1).join('.')
        : segments.join('.')
    // Blocks are the section's body: the heading line (and a setext underline) is not a block.
    const bodyStart = s.startLine + (SETEXT.test(lines[s.startLine] ?? '') ? 2 : 1)
    symbols.push({
      kind: 'region',
      name: s.title,
      qualifiedName,
      parent: qualifiedName.includes('.')
        ? qualifiedName.slice(0, qualifiedName.lastIndexOf('.'))
        : null,
      startLine: s.startLine,
      endLine: s.endLine,
      blocks: paragraphs(lines, bodyStart, s.endLine),
    })
  }
  return symbols
}

/** Paragraphs and fenced blocks between two lines (1-based, inclusive), as citation blocks. */
function paragraphs(lines: string[], from: number, to: number): CitationBlock[] {
  const out: CitationBlock[] = []
  let start: number | null = null
  let fence = false
  for (let n = from; n <= to; n++) {
    const line = lines[n - 1] ?? ''
    if (FENCE.test(line)) {
      if (!fence && start === null) start = n
      fence = !fence
      if (!fence) {
        out.push({ startLine: start!, endLine: n })
        start = null
      }
      continue
    }
    if (fence) continue
    if (line.trim()) {
      if (start === null) start = n
    } else if (start !== null) {
      out.push({ startLine: start, endLine: n - 1 })
      start = null
    }
  }
  if (start !== null) out.push({ startLine: start, endLine: to })
  return out
}

function firstNonBlank(lines: string[], from: number, to: number): number {
  for (let n = from; n <= to; n++) if ((lines[n - 1] ?? '').trim()) return n
  return from
}

function lastNonBlank(lines: string[], from: number, to: number): number {
  for (let n = to; n >= from; n--) if ((lines[n - 1] ?? '').trim()) return n
  return 0
}
