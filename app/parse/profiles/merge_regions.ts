import { chunkWeight, MAX_CHUNK_CHARS } from '#app/parse/chunker'
import type { ParsedSymbol } from '#app/parse/profiles/node_symbols'

/**
 * Consecutive regions are packed up to the chunk budget. The chunker emits one chunk per
 * symbol and never fewer, so a profile that makes every heading or key a region gives a file as
 * many chunks as it has headings, whatever each weighs: a 6,600-line changelog produced 1,459
 * chunks of 378 characters against an 1,800 budget, failing the robustness tier's per-file
 * invariant (Eigenwise/eigenwise-toolshed, 2026-09-20).
 *
 * Only region profiles call this — Markdown and JSON, selected by file extension — so code
 * chunking cannot reach it. Citation blocks are concatenated, not merged: what can be cited stays
 * paragraph- or line-sized, and only the retrieval and embedding unit grows.
 */
export function mergeRegions(symbols: ParsedSymbol[], lines: string[]): ParsedSymbol[] {
  // Weighted: a non-ASCII character counts three, so a CJK region stays within the
  // embedder's tokens as surely as a code one.
  const length = (from: number, to: number) => chunkWeight(lines.slice(from - 1, to).join('\n'))
  // Profiles trim a region to its last non-blank line, so neighbours are separated by blank lines
  // that belong to neither; only blank lines may lie between two regions that merge.
  const onlyBlankBetween = (end: number, start: number) =>
    lines.slice(end, start - 1).every((line) => !line.trim())
  const merged: ParsedSymbol[] = []
  for (const symbol of symbols) {
    const previous = merged[merged.length - 1]
    const joinable =
      previous !== undefined &&
      previous.kind === 'region' &&
      symbol.kind === 'region' &&
      symbol.startLine > previous.endLine &&
      onlyBlankBetween(previous.endLine, symbol.startLine) &&
      length(previous.startLine, symbol.endLine) <= MAX_CHUNK_CHARS
    if (!joinable) {
      merged.push({ ...symbol })
      continue
    }
    // The merged region names its span, so a citation still says where in the file it came from.
    const first = previous.name.split(' … ')[0]
    previous.name = first === symbol.name ? first : `${first} … ${symbol.name}`
    previous.qualifiedName = `${previous.qualifiedName.split(' … ')[0]} … ${symbol.qualifiedName}`
    previous.parent = previous.parent === symbol.parent ? previous.parent : null
    previous.endLine = symbol.endLine
    previous.blocks = [...previous.blocks, ...symbol.blocks]
  }
  return merged
}
