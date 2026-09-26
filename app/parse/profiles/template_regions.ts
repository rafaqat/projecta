import type { CitationBlock, ParsedSymbol } from '#app/parse/profiles/node_symbols'

/**
 * Templates and markup without a grammar: Handlebars, EJS, Pug, HTML, Vue and the like
 * are what questions about screens, forms and pages are answered from (UAT 2026-09-16, StyleSwap:
 * "is there a management screen for stock" found no evidence; 64 of 64 templates had no chunks).
 * A file is one region; each run of non-blank lines, cut at BLOCK_LINES, is a citation block.
 * Never parsed by tree-sitter; declares nothing to the vocabulary.
 */
export const BLOCK_LINES = 20

export function extractTemplateRegions(content: string): ParsedSymbol[] {
  const lines = content.split('\n')
  const blocks: CitationBlock[] = []
  let start: number | null = null
  const close = (end: number) => {
    for (let from = start!; from <= end; from += BLOCK_LINES)
      blocks.push({ startLine: from, endLine: Math.min(from + BLOCK_LINES - 1, end) })
    start = null
  }
  lines.forEach((line, i) => {
    if (line.trim()) start ??= i + 1
    else if (start !== null) close(i)
  })
  if (start !== null) close(lines.length)
  if (blocks.length === 0) return []
  return [
    {
      kind: 'region',
      name: 'template',
      qualifiedName: '<file>#1',
      parent: null,
      startLine: blocks[0].startLine,
      endLine: blocks[blocks.length - 1].endLine,
      blocks,
    },
  ]
}
