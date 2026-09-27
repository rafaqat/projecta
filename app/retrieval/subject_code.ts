import { inScope, type Scope } from '#app/security/scope'

/**
 * The code a "what does this do" answer must come from: the bodies of the functions a
 * question names, the handlers of the routes it names or lists, and the rest of any function
 * retrieval returned only part of. Everything here is read from the index; nothing from model
 * text.
 */
export const BODY_CHUNKS_PER_SYMBOL = 6
export const SUBJECT_CHUNKS = 12
export const HANDLER_CHUNKS = 16
export const COMPLETED_FUNCTIONS = 4

const CALLABLE_KINDS = ['function', 'method', 'class']

export interface SubjectSymbol {
  id: string
  qualifiedName: string
  kind: string
  path: string
  startLine: number
  endLine: number
}

export interface RouteRow {
  method: string
  path: string
  file: string
  line: number
}

export interface RouteHandlers extends RouteRow {
  /** Handlers the route line resolves to; empty for an inline handler or an unresolved one. */
  handlers: SubjectSymbol[]
  /** For an inline handler (no symbol): the chunk holding the route line. */
  inlineChunkId: string | null
}

/** Every chunk of each symbol, in line order, capped per symbol and in all. */
export async function bodyChunkIds(
  scope: Scope,
  symbolIds: string[],
  cap: number,
  perSymbol = BODY_CHUNKS_PER_SYMBOL
): Promise<string[]> {
  if (symbolIds.length === 0) return []
  const rows = await inScope(scope, (trx) =>
    trx
      .from('chunks')
      .whereIn('symbol_id', symbolIds)
      .orderBy(['start_line'])
      .select('id', 'symbol_id')
  )
  const out: string[] = []
  for (const id of symbolIds) {
    const own = rows.filter((r) => r.symbol_id === id).slice(0, perSymbol)
    for (const r of own) {
      if (out.length >= cap) return out
      out.push(String(r.id))
    }
  }
  return out
}

/** The functions, methods and classes the question's anchors name, by qualified or short name. */
export async function namedSymbols(
  scope: Scope,
  commitId: string,
  anchors: string[],
  limit = 3
): Promise<SubjectSymbol[]> {
  const names = [...new Set(anchors.map((a) => a.toLowerCase()).filter((a) => !a.includes('/')))]
  if (names.length === 0) return []
  const rows = await inScope(scope, (trx) =>
    trx
      .from('symbols')
      .where('commit_id', commitId)
      .whereIn('kind', CALLABLE_KINDS)
      .where((q) =>
        q
          .whereRaw('lower(qualified_name) = any(?)', [names])
          .orWhereRaw('lower(name) = any(?)', [names])
      )
      .orderBy(['path', 'start_line'])
      .select('id', 'qualified_name', 'kind', 'path', 'start_line', 'end_line')
  )
  return rows.slice(0, limit).map(toSymbol)
}

/** Each route row's handlers, from the `route_handler` references on its file and line. */
export async function routeHandlers(
  scope: Scope,
  commitId: string,
  rows: RouteRow[]
): Promise<RouteHandlers[]> {
  if (rows.length === 0) return []
  const files = [...new Set(rows.map((r) => r.file))]
  const { refs, chunks } = await inScope(scope, async (trx) => {
    const found = await trx
      .from('symbol_references as r')
      .leftJoin('symbols as s', 's.id', 'r.to_symbol_id')
      .where('r.commit_id', commitId)
      .where('r.kind', 'route_handler')
      .whereIn('r.path', files)
      .select(
        'r.path as ref_path',
        'r.line',
        's.id',
        's.qualified_name',
        's.kind',
        's.path',
        's.start_line',
        's.end_line'
      )
    const lineChunks = await trx
      .from('chunks')
      .where('commit_id', commitId)
      .whereIn('path', files)
      .select('id', 'path', 'start_line', 'end_line')
    return { refs: found, chunks: lineChunks }
  })
  return rows.map((row) => {
    const onLine = refs.filter((r) => r.ref_path === row.file && Number(r.line) === row.line)
    const handlers = onLine.filter((r) => r.id).map(toSymbol)
    const unique = [...new Map(handlers.map((h) => [h.id, h])).values()]
    const inline =
      unique.length === 0
        ? chunks.find(
            (c) => c.path === row.file && c.start_line <= row.line && c.end_line >= row.line
          )
        : undefined
    return { ...row, handlers: unique, inlineChunkId: inline ? String(inline.id) : null }
  })
}

/** Route rows whose path the question names (`/apply-coupon-code`, `GET /orders/:orderId/refund`). */
export function namedRoutes<T extends RouteRow>(question: string, rows: T[]): T[] {
  const written = new Set(
    (question.match(/(?:^|[\s`'"(])(\/[\w\-/:.{}*]*)/g) ?? []).map((m) =>
      m
        .replace(/^[\s`'"(]/, '')
        .replace(/[.,;:?!]+$/, '')
        .toLowerCase()
    )
  )
  if (written.size === 0) return []
  return rows.filter((r) => written.has(r.path.toLowerCase()))
}

/** The rest of each function retrieval returned only part of, for the first few such functions. */
export async function completingChunkIds(
  scope: Scope,
  retrieved: string[],
  cap = SUBJECT_CHUNKS,
  functions = COMPLETED_FUNCTIONS
): Promise<string[]> {
  if (retrieved.length === 0) return []
  const rows = await inScope(scope, (trx) =>
    trx
      .from('chunks as c')
      .join('symbols as s', 's.id', 'c.symbol_id')
      .whereIn('c.id', retrieved)
      .whereIn('s.kind', ['function', 'method'])
      .select('c.id', 's.id as symbol_id')
  )
  const order = new Map(retrieved.map((id, i) => [id, i]))
  const symbols: string[] = []
  for (const r of [...rows].sort((x, y) => order.get(x.id)! - order.get(y.id)!))
    if (!symbols.includes(r.symbol_id) && symbols.length < functions) symbols.push(r.symbol_id)
  const have = new Set(retrieved)
  const body = await bodyChunkIds(scope, symbols, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
  return body.filter((id) => !have.has(id)).slice(0, cap)
}

function toSymbol(r: Record<string, unknown>): SubjectSymbol {
  return {
    id: String(r.id),
    qualifiedName: String(r.qualified_name),
    kind: String(r.kind),
    path: String(r.path),
    startLine: Number(r.start_line),
    endLine: Number(r.end_line),
  }
}
