import type { OutlinedDeclaration } from '#app/assistant/verification'
import { createHash } from 'node:crypto'
import { TurnHandleRegistry, type EvidenceRef } from '#app/assistant/handles'
import { commentLines } from '#app/assistant/quoted_comment'
import type { NativeCitation, SearchResultBlock } from '#app/assistant/model'
import type { AnswerEvent, LineRange, SymbolRef } from '#app/assistant/protocol'
import { inScope, type Scope } from '#app/security/scope'
import { withoutComments } from '#app/assistant/verification'

/**
 * Evidence for one turn: retrieved chunks become
 * search-result blocks whose content blocks are the symbol's statement-level
 * citation blocks, addressed by a turn-local handle. Citations returned by
 * the model are hydrated from the index here, never from model text, and
 * every one carries the SHA-256 of the exact lines it cites.
 */
export interface EvidenceItem extends EvidenceRef {
  commitSha: string
  blocks: LineRange[]
  lines: string[] // whole blob, 1-based via index + 1
  symbol: SymbolRef | null
  /** Flagged at ingest as instruction-shaped (T-07); the decision record names it. */
  injectionSuspected: boolean
}

/** The largest declaration shown around an exact span (WP-28); beyond it the pane shows the span alone. */
export const CONTEXT_MAX_LINES = 40

export function spanSha256(lines: string[], span: LineRange): string {
  return createHash('sha256')
    .update(lines.slice(span.start - 1, span.end).join('\n'))
    .digest('hex')
}

export class TurnEvidence {
  private readonly registry = new TurnHandleRegistry()
  private readonly items = new Map<string, EvidenceItem>()

  /** Outlines the turn put in evidence: the decision record's declaration lists, by file. */
  private readonly outlines: Array<{ path: string; declarations: OutlinedDeclaration[] }> = []
  private outlineListeners: Array<(path: string, declarations: OutlinedDeclaration[]) => void> = []

  constructor(
    private readonly scope: Scope,
    private readonly commitSha: string
  ) {}

  /** A file's outline joined the evidence; whoever listens (the verifier) learns its declarations. */
  addOutline(path: string, declarations: OutlinedDeclaration[]): void {
    this.outlines.push({ path, declarations })
    for (const listen of this.outlineListeners) listen(path, declarations)
  }

  /** Called for every outline already added and every one to come (the gate attaches after the turn starts). */
  onOutline(listen: (path: string, declarations: OutlinedDeclaration[]) => void): void {
    this.outlineListeners.push(listen)
    for (const o of this.outlines) listen(o.path, o.declarations)
  }

  handles(): string[] {
    return this.registry.handles()
  }

  /** Distinct paths of every evidence item this turn holds, sorted: what a no_instance notice covers. */
  paths(): string[] {
    return [...new Set([...this.items.values()].map((i) => i.path))].sort()
  }

  resolve(handle: string): EvidenceItem | undefined {
    return this.items.get(handle)
  }

  /**
   * The resolved repository callees of the symbol behind a handle (one hop, calls and
   * constructions, exact and alias resolutions), for the citation's "calls" pills. Cached per
   * symbol for the turn.
   */
  private readonly calleeCache = new Map<
    string,
    Array<{ name: string; path: string; line: number }>
  >()
  async calleesOf(handle: string): Promise<Array<{ name: string; path: string; line: number }>> {
    const item = this.items.get(handle)
    if (!item?.symbolId) return []
    const cached = this.calleeCache.get(item.symbolId)
    if (cached) return cached
    const rows = await inScope(this.scope, (trx) =>
      trx
        .from('symbol_references as r')
        .join('symbols as s', 's.id', 'r.to_symbol_id')
        .where('r.from_symbol_id', item.symbolId!)
        .whereIn('r.kind', ['call', 'new'])
        .whereIn('r.resolution', ['exact', 'alias'])
        .whereIn('s.kind', ['function', 'method', 'class'])
        .orderBy('r.line')
        .select('s.qualified_name', 's.path', 's.start_line')
    )
    const seen = new Set<string>()
    const callees: Array<{ name: string; path: string; line: number }> = []
    for (const r of rows) {
      const name = String(r.qualified_name)
      if (seen.has(name) || name === item.symbol?.qualifiedName) continue
      seen.add(name)
      callees.push({ name, path: String(r.path), line: Number(r.start_line) })
      if (callees.length >= 6) break
    }
    this.calleeCache.set(item.symbolId, callees)
    return callees
  }

  /**
   * The comment lines of every span shown this turn, for the gate's quoted-comment rule
   * (app/assistant/quoted_comment.ts). Recomputed when evidence is added; only shown lines count.
   */
  private commentCache: { size: number; lines: string[] } | null = null
  comments(): string[] {
    if (this.commentCache?.size === this.items.size) return this.commentCache.lines
    const lines: string[] = []
    for (const item of this.items.values())
      lines.push(...commentLines(item.lines.slice(item.span.start - 1, item.span.end)))
    this.commentCache = { size: this.items.size, lines }
    return lines
  }

  /** Chunk ids of evidence flagged at ingest as instruction-shaped. */
  flaggedChunkIds(): Set<string> {
    const ids = new Set<string>()
    for (const item of this.items.values()) if (item.injectionSuspected) ids.add(item.chunkId)
    return ids
  }

  /**
   * Loads chunks by id inside the actor's scope and mints one handle per chunk.
   * The query itself is exercised by the functional span-hash test (AC-WP06-03);
   * mutation testing covers the pure builders below.
   */
  // Stryker disable all
  async addChunks(
    chunkIds: string[],
    /** A label per chunk id for the block title: the relation and seed it came from. */
    labels: ReadonlyMap<string, string> = new Map()
  ): Promise<SearchResultBlock[]> {
    if (chunkIds.length === 0) return []
    const rows = await inScope(this.scope, async (trx) => {
      const chunks = await trx
        .from('chunks')
        .whereIn('chunks.id', chunkIds)
        .leftJoin('symbols', 'symbols.id', 'chunks.symbol_id')
        .leftJoin('blobs', function () {
          this.on('blobs.blob_sha', 'chunks.blob_sha').andOn(
            'blobs.workspace_id',
            'chunks.workspace_id'
          )
        })
        .select(
          'chunks.id',
          'chunks.path',
          'chunks.blob_sha',
          'chunks.symbol_id',
          'chunks.start_line',
          'chunks.end_line',
          'chunks.injection_suspected',
          'symbols.qualified_name',
          'symbols.kind',
          'symbols.start_line as symbol_start',
          'symbols.end_line as symbol_end',
          'blobs.content'
        )
      const symbolIds = chunks.map((c) => c.symbol_id).filter(Boolean)
      const blocks = symbolIds.length
        ? await trx.from('citation_blocks').whereIn('symbol_id', symbolIds).orderBy('ordinal')
        : []
      // A retrieval hit that is not a chunk is a honeytoken (search.ts): the sensor for a lost
      // workspace filter (SEC-30). It reaches the model as evidence like any hit, so that the
      // gateway's outbound rule can see it echoed; dropping it here silenced the alarm (owner
      // review, 2026-09-17). Read by id only — an id gets here only through retrieval.
      const found = new Set(chunks.map((c) => String(c.id)))
      const tokenIds = chunkIds.filter((id) => !found.has(id))
      const tokens = tokenIds.length
        ? await trx.from('honeytokens').whereIn('id', tokenIds).select('id', 'text')
        : []
      return { chunks: [...chunks, ...tokens.map(honeytokenRow)], blocks }
    })
    const out: SearchResultBlock[] = []
    for (const item of buildItems(chunkIds, rows.chunks, rows.blocks, this.commitSha)) {
      const handle = this.registry.register(item)
      this.items.set(handle, item)
      out.push(searchResultBlock(handle, item, labels.get(item.chunkId)))
    }
    return out
  }
  // Stryker restore all

  /**
   * Native citation → AnswerEvent. Returns null for a handle this turn never
   * minted (foreign handle, database ID, SHA) or a block index outside the
   * search result: nothing is rendered for it (INV-13).
   */
  hydrate(citation: NativeCitation): Extract<AnswerEvent, { type: 'citation' }> | null {
    const item = this.items.get(citation.handle)
    return item ? hydrateCitation(item, citation) : null
  }

  /** Why a citation did not hydrate: the handle was never minted, or its block range is outside the item. */
  unresolvedReason(citation: NativeCitation): 'unknown_handle' | 'block_out_of_range' | null {
    const item = this.items.get(citation.handle)
    if (!item) return 'unknown_handle'
    if (!item.blocks[citation.startBlock] || !item.blocks[citation.endBlock])
      return 'block_out_of_range'
    return null
  }

  /** What was sent for a handle: its block count and location, for a citation that did not resolve. */
  describe(handle: string): { path: string; span: string; blocks: number } | null {
    const item = this.items.get(handle)
    return item
      ? { path: item.path, span: `${item.span.start}-${item.span.end}`, blocks: item.blocks.length }
      : null
  }

  /** Marker fallback `[[cite:r3]]` cites the handle's whole retrieved span. */
  hydrateMarker(handle: string) {
    const item = this.items.get(handle)
    return item ? hydrateCitation(item, wholeSpan(handle, item)) : null
  }
}

const normalise = (text: string) => text.replace(/\s+/g, ' ').trim()

const IDENT = /[A-Za-z_$][\w$]{2,}/g

function identifierOverlap(citedText: string, lines: string[], span: LineRange): number {
  const cited = new Set(citedText.match(IDENT) ?? [])
  if (cited.size === 0) return 1 // nothing to check: trust the block index
  const inSpan = new Set(
    lines
      .slice(span.start - 1, span.end)
      .join('\n')
      .match(IDENT) ?? []
  )
  let hits = 0
  for (const id of cited) if (inSpan.has(id)) hits++
  return hits / cited.size
}

export const MARKER = /\[\[cite:(r\d{1,4})\]\]/g

/** Database row shapes the pure builders accept; the query above selects exactly these columns. */
export interface ChunkRow {
  id: string
  path: string
  blob_sha: string
  symbol_id: string | null
  start_line: number
  end_line: number
  qualified_name: string | null
  kind: string | null
  symbol_start: number | null
  symbol_end: number | null
  content: string | null
  injection_suspected?: boolean
}
export interface BlockRow {
  symbol_id: string
  start_line: number
  end_line: number
}

/** Chunks in request order become items; a chunk without stored content (skipped blob) is dropped. */
export function buildItems(
  chunkIds: string[],
  chunks: ChunkRow[],
  blocks: BlockRow[],
  commitSha: string
): EvidenceItem[] {
  const byId = new Map(chunks.map((c) => [c.id, c]))
  const items: EvidenceItem[] = []
  for (const id of chunkIds) {
    const c = byId.get(id)
    if (!c || c.content === null) continue
    const span = { start: c.start_line, end: c.end_line }
    // Statement blocks that overlap the chunk, clipped to it; a symbol-less region is one block.
    const statements = blocks
      .filter(
        (b) => b.symbol_id === c.symbol_id && b.end_line >= span.start && b.start_line <= span.end
      )
      .map((b) => ({
        start: Math.max(b.start_line, span.start),
        end: Math.min(b.end_line, span.end),
      }))
    // What ranks is what is shown: the lines between and around the statement blocks —
    // a comment between two class members, a decorator, a blank-line-separated note — are in the
    // chunk's text, which is embedded and BM25-indexed, so they are blocks of their own here too.
    // Before this they were in neither, and text there steered retrieval unseen by model and
    // reader alike. Blank runs are left out: an empty block shows nothing and costs a block index.
    const inChunk = withGaps(statements, span, String(c.content).split('\n'))
    const symbol: SymbolRef | null = c.symbol_id
      ? {
          path: c.path,
          qualifiedName: c.qualified_name!,
          kind: c.kind!,
          span: { start: c.symbol_start!, end: c.symbol_end! },
        }
      : null
    items.push({
      chunkId: c.id,
      symbolId: c.symbol_id,
      path: c.path,
      blobSha: c.blob_sha,
      span,
      commitSha,
      blocks: inChunk.length ? inChunk : [span],
      lines: String(c.content).split('\n'),
      symbol,
      injectionSuspected: c.injection_suspected === true,
    })
  }
  return items
}

/**
 * The statement blocks in order, with every uncovered line of the span shown in a block,
 * each line in the block it belongs to: an uncovered run that holds code — a signature,
 * `} else {`, `} catch (error) {` — joins the block after it; a trailing run of closing punctuation
 * joins the block before it; a run that is only comment stays a block of its own, so the "comment,
 * not code" badge still fires when it is cited alone. Before this the signature and the closing
 * brace were one-line blocks the model left off: none of 129 function citations in one paid run
 * included the closer (2026-09-20). A gap of nothing but blank lines is dropped.
 */
const CLOSING_ONLY = /^[\s{}()[\];,]*$/

function withGaps(statements: LineRange[], span: LineRange, lines: string[]): LineRange[] {
  if (statements.length === 0) return []
  const ordered = [...statements].sort((a, b) => a.start - b.start || a.end - b.end)
  const text = (start: number, end: number) => lines.slice(start - 1, end)
  const blank = (start: number, end: number) => !text(start, end).some((line) => line.trim())
  const commentOnly = (start: number, end: number) =>
    withoutComments(text(start, end).join('\n'))
      .split('\n')
      .every((line) => !line.trim())
  const closingOnly = (start: number, end: number) =>
    text(start, end).every((line) => CLOSING_ONLY.test(line))
  const out: LineRange[] = []
  let pending: LineRange | null = null
  let cursor = span.start
  for (const block of ordered) {
    if (block.start > cursor) {
      const gap = { start: cursor, end: block.start - 1 }
      if (!blank(gap.start, gap.end)) {
        if (commentOnly(gap.start, gap.end)) out.push(gap)
        else pending = gap
      }
    }
    out.push(pending ? { start: pending.start, end: block.end } : { ...block })
    pending = null
    cursor = Math.max(cursor, block.end + 1)
  }
  if (cursor <= span.end && !blank(cursor, span.end)) {
    const last = out[out.length - 1]
    if (!commentOnly(cursor, span.end) && closingOnly(cursor, span.end))
      out[out.length - 1] = { start: last.start, end: span.end }
    else out.push({ start: cursor, end: span.end })
  }
  return out
}

/** A honeytoken as the chunk row search presents it: the planted snippet at `config/integrations.ts`. */
function honeytokenRow(token: { id: string; text: string }): ChunkRow {
  const text = String(token.text).replace(/\n$/, '')
  return {
    id: String(token.id),
    path: 'config/integrations.ts',
    blob_sha: '',
    symbol_id: null,
    start_line: 1,
    end_line: text.split('\n').length,
    qualified_name: null,
    kind: null,
    symbol_start: null,
    symbol_end: null,
    content: text,
  }
}

/** Where the span sits in the file, so the model knows whether the evidence is the whole of it. */
function extentOf(item: EvidenceItem): string {
  const total = item.lines.length
  return item.span.start <= 1 && item.span.end >= total
    ? `complete file, ${total} line${total === 1 ? '' : 's'}`
    : `lines ${item.span.start}–${item.span.end} of ${total}`
}

export function searchResultBlock(
  handle: string,
  item: EvidenceItem,
  label?: string
): SearchResultBlock {
  return {
    type: 'search_result',
    source: handle,
    title: `${item.symbol ? `${item.path} ${item.symbol.qualifiedName}` : item.path} (${extentOf(item)})${label ? ` · ${label}` : ''}`,
    content: item.blocks.map((b) => ({
      type: 'text',
      text: item.lines.slice(b.start - 1, b.end).join('\n'),
    })),
  }
}

/**
 * Native citation → AnswerEvent, from the item alone. Null for a block index
 * outside the search result. Weak identifier overlap between the cited text
 * and the span widens the citation to the enclosing symbol.
 */
export function hydrateCitation(
  item: EvidenceItem,
  citation: NativeCitation
): Extract<AnswerEvent, { type: 'citation' }> | null {
  const first = item.blocks[citation.startBlock]
  let endBlock = citation.endBlock
  // An end one past the result is clamped when the cited text lies inside what remains:
  // the model cited a one-block result as blocks 0..1 with the text of that block, on the same
  // question in two paid runs, and the citation was dropped. Empty cited text earns no tolerance.
  if (
    first &&
    endBlock === item.blocks.length &&
    endBlock > citation.startBlock &&
    citation.citedText.trim()
  ) {
    endBlock = item.blocks.length - 1
    const shown = normalise(item.lines.slice(first.start - 1, item.blocks[endBlock].end).join('\n'))
    if (!shown.includes(normalise(citation.citedText))) return null
  }
  const last = item.blocks[endBlock]
  if (!first || !last || endBlock < citation.startBlock) return null
  let span: LineRange = { start: first.start, end: last.end }
  let precision: 'span' | 'symbol' = 'span'
  if (item.symbol && identifierOverlap(citation.citedText, item.lines, span) < 0.5) {
    span = item.symbol.span
    precision = 'symbol'
  }
  const cited = item.lines.slice(span.start - 1, span.end)
  // The declaration around an exact span, for the reader (WP-28). Only when the span is strictly
  // inside a small declaration: a whole-symbol citation already shows it, and the pane is not a
  // file viewer. What was cited — span, snippet, hash — is not touched by this.
  const around = item.symbol?.span
  const context =
    precision === 'span' &&
    around &&
    around.start <= span.start &&
    around.end >= span.end &&
    (around.start < span.start || around.end > span.end) &&
    around.end - around.start + 1 <= CONTEXT_MAX_LINES
      ? { start: around.start, lines: item.lines.slice(around.start - 1, around.end) }
      : undefined
  const commentOnly =
    cited.some((line) => line.trim().length > 0) &&
    withoutComments(cited.join('\n'))
      .split('\n')
      .every((line) => !line.trim())
  return {
    type: 'citation',
    handle: citation.handle,
    ...(commentOnly ? { commentOnly } : {}),
    ...(context ? { context } : {}),
    commitSha: item.commitSha,
    blobSha: item.blobSha,
    spanSha256: spanSha256(item.lines, span),
    symbol: item.symbol ?? {
      path: item.path,
      qualifiedName: item.path,
      kind: 'region',
      span: item.span,
    },
    span,
    snippet: item.lines.slice(span.start - 1, span.end).join('\n'),
    precision,
    origin: 'repo',
  }
}

/** The marker fallback cites every block of the handle's search result. */
export function wholeSpan(handle: string, item: EvidenceItem): NativeCitation {
  return { handle, startBlock: 0, endBlock: item.blocks.length - 1, citedText: '' }
}
