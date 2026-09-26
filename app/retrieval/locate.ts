import { retrieve } from '#app/retrieval/hybrid'
import { splitIdentifier } from '#app/retrieval/search_text'
import { inScope, type Scope } from '#app/security/scope'

/**
 * "Where is <feature> implemented?" names no symbol. The answer is a map
 *: hybrid retrieval rolled up from chunks to the declarations
 * they belong to, joined by the declarations whose names, paths or
 * endpoints match the question's words, then re-ranked by deterministic
 * signals — definitions over call sites, tests demoted unless asked about,
 * a bonus for reference edges to other candidates, capped at two (the symbol
 * that ties the hits together is the implementation;), a bonus for entry points —
 * and grouped by architectural layer from path conventions. Every row is a
 * declaration at the commit with a chunk to cite; the model narrates the
 * map. Nothing located is said so.
 */
export interface LocatedSymbol {
  symbolId: string | null
  qualifiedName: string
  kind: string
  path: string
  startLine: number
  endLine: number
  score: number
  /** Which signals contributed: retrieval, name, path, endpoint, definition, connected, entry, test. */
  why: string[]
  endpoints: string[]
  chunkId: string | null
}

export interface LocatedLayer {
  layer: string
  symbols: LocatedSymbol[]
}

export interface Located {
  words: string[]
  layers: LocatedLayer[]
  /** The best chunk of every listed symbol: what the model cites. */
  chunkIds: string[]
}

const STOP = new Set(
  'a an the is are was were be been being do does did done how what where which who whom why when in on at to for of by with from into as and or not no it its this that these those there here implemented implement implements implementation handled handle handles handling defined define defines definition located live lives lived happen happens code file files function functions class classes method methods logic feature functionality part module modules component components repo repository codebase app application our we you i can could should would will'.split(
    /\s+/
  )
)

/** The question's content words, singular-ish and lower-case, in order. */
export function featureWords(question: string): string[] {
  const out: string[] = []
  for (const raw of question
    .toLowerCase()
    .replace(/[`'"]/g, ' ')
    .match(/[a-z][a-z0-9_-]{2,}/g) ?? []) {
    const word = raw
      .replace(/(ies)$/, 'y')
      .replace(/(sses|xes|ches|shes)$/, (m) => m.slice(0, -2))
      .replace(/s$/, '')
    if (STOP.has(raw) || STOP.has(word) || out.includes(word)) continue
    out.push(word)
  }
  return out
}

const stem = (token: string) => token.replace(/(ies)$/, 'y').replace(/s$/, '')
/** A token matches a word exactly, or by a prefix when both are long enough to mean something (`refund`/`refunded`). */
const matches = (tokens: Iterable<string>, words: string[]): string[] => {
  const seen = new Set<string>()
  for (const t of tokens) {
    const s = stem(t.toLowerCase())
    for (const w of words) {
      if (s === w) seen.add(w)
      else if (s.length >= 4 && w.length >= 4 && (s.startsWith(w) || w.startsWith(s))) seen.add(w)
    }
  }
  return [...seen]
}

/** Architectural layers by path convention; the first match names the layer. */
const LAYERS: Array<[string, RegExp]> = [
  [
    'tests',
    /(^|\/)(tests?|__tests__|spec|specs|.*Tests|androidTest)\/|\.(test|spec)\.[jt]sx?$|Tests\.swift$|Test\.kt$/,
  ],
  ['routes', /(^|\/)(routes?|routers?|api)\//],
  ['controllers', /(^|\/)controllers?\//],
  ['middleware', /(^|\/)middlewares?\//],
  // Android: view models, repositories and utilities are the app's services.
  [
    'services',
    /(^|\/)(services?|domain|usecases?|lib|viewmodels?|repositor(y|ies)|utilities|utils?)\//,
  ],
  ['models', /(^|\/)(models?|entities|schemas?|database|persistence|db|room|dao)\//],
  ['jobs', /(^|\/)(jobs?|workers?|queues?|tasks?|receivers?)\//],
  [
    'ui',
    /(^|\/)(components?|views?|pages?|screens?|Sources|activities|fragments|adapters|compose|ui)\//,
  ],
  ['config', /(^|\/)(config|start|settings|res)\//],
]
const layerOf = (path: string) => LAYERS.find(([, re]) => re.test(path))?.[0] ?? 'other'
const TEST_PATH = LAYERS[0][1]
const DEFINITION = new Set([
  'class',
  'function',
  'method',
  'struct',
  'protocol',
  'enum',
  'interface',
])
const LAYER_ORDER = [
  'routes',
  'controllers',
  'middleware',
  'services',
  'models',
  'jobs',
  'ui',
  'config',
  'other',
  'tests',
]
const MAX_SYMBOLS = 12

/**
 * Connections to other candidates that count toward the bonus. Uncapped, the bonus was a
 * degree signal: route files and session middleware, connected to nearly every candidate, rose
 * above the code a question named (StyleSwap eval, 2026-09-16).
 */
export const MAX_CONNECTIONS = 2

/** The ranking bonus for a candidate connected to `connected` other candidates. */
export function connectionBonus(connected: number): number {
  return 0.5 * Math.min(connected, MAX_CONNECTIONS)
}

export async function locate(scope: Scope, commitId: string, question: string): Promise<Located> {
  const words = featureWords(question)
  if (words.length === 0) return { words, layers: [], chunkIds: [] }
  const aboutTests = /\btests?\b|\bspec\b/i.test(question)
  const retrieval = await retrieve(scope, commitId, question)
  return inScope(scope, async (trx) => {
    const rows = new Map<string, LocatedSymbol>()
    const keyOf = (symbolId: string | null, path: string) => symbolId ?? `file:${path}`
    const note = (s: LocatedSymbol, why: string) => {
      if (!s.why.includes(why)) s.why.push(why)
    }
    const rowFor = async (symbolId: string | null, path: string): Promise<LocatedSymbol> => {
      const key = keyOf(symbolId, path)
      const existing = rows.get(key)
      if (existing) return existing
      let row: LocatedSymbol = {
        symbolId: null,
        qualifiedName: '<file>',
        kind: 'region',
        path,
        startLine: 1,
        endLine: 1,
        score: 0,
        why: [],
        endpoints: [],
        chunkId: null,
      }
      if (symbolId) {
        const s = await trx
          .from('symbols')
          .where('id', symbolId)
          .select('qualified_name', 'kind', 'path', 'start_line', 'end_line')
          .first()
        if (s)
          row = {
            ...row,
            symbolId,
            qualifiedName: String(s.qualified_name),
            kind: String(s.kind),
            path: String(s.path),
            startLine: Number(s.start_line),
            endLine: Number(s.end_line),
          }
      }
      rows.set(key, row)
      return row
    }

    // 1. Retrieval rolled up: the best fused chunk per declaration — only when retrieval found
    // enough (nearest neighbours of an unrelated question are not a feature's implementation).
    const chunkRows =
      retrieval.status === 'ok' && retrieval.chunks.length
        ? ((await trx
            .from('chunks')
            .whereIn(
              'id',
              retrieval.chunks.map((c) => c.id)
            )
            .select('id', 'symbol_id', 'path')) as Array<{
            id: string
            symbol_id: string | null
            path: string
          }>)
        : []
    const chunkById = new Map(chunkRows.map((c) => [String(c.id), c]))
    for (const c of retrieval.status === 'ok' ? retrieval.chunks : []) {
      const meta = chunkById.get(c.id)
      if (!meta) continue
      const row = await rowFor(meta.symbol_id ? String(meta.symbol_id) : null, String(meta.path))
      const fused = Number((c as { fused?: number }).fused ?? 0) * 100
      if (fused > row.score) row.score = fused
      row.chunkId ??= String(c.id)
      note(row, 'retrieval')
    }

    // 2. Declarations named for the feature, and files whose path names it.
    const symbols = (await trx
      .from('symbols')
      .where('commit_id', commitId)
      .whereNotIn('kind', ['region', 'import'])
      .select('id', 'name', 'path')) as Array<{ id: string; name: string; path: string }>
    for (const s of symbols) {
      const hit = matches(splitIdentifier(s.name), words)
      const pathHit = matches(
        s.path.split('/').flatMap((seg) => splitIdentifier(seg.replace(/\.[a-z0-9]+$/i, ''))),
        words
      )
      if (!hit.length && !pathHit.length) continue
      const row = await rowFor(String(s.id), s.path)
      if (hit.length) {
        row.score += 2 * hit.length
        note(row, 'name')
      }
      if (pathHit.length) {
        row.score += pathHit.length
        note(row, 'path')
      }
    }

    // 3. Endpoints naming the feature: the handler, or the route file's top level, is an entry.
    const endpoints = (await trx
      .from('endpoints')
      .where('commit_id', commitId)
      .select('method', 'path', 'file', 'handler')) as Array<{
      method: string
      path: string
      file: string
      handler: string | null
    }>
    for (const e of endpoints) {
      const hit = matches([...e.path.split(/[/:.-]+/), ...splitIdentifier(e.handler ?? '')], words)
      if (!hit.length) continue
      const handlerName = e.handler?.split('.').pop()
      const handler = handlerName
        ? symbols.find((s) => s.path === e.file && s.name === handlerName)
        : undefined
      const row = await rowFor(handler ? String(handler.id) : null, e.file)
      row.score += 2 * hit.length
      note(row, 'endpoint')
      row.endpoints.push(`${String(e.method).toUpperCase()} ${e.path}`)
    }

    const candidates = [...rows.values()].filter((r) => r.score > 0)
    // Retrieval's neighbours alone are not a location: something must name the feature —
    // a declaration, a path or an endpoint — for the map to exist at all.
    const named = candidates.some((c) =>
      c.why.some((w) => w === 'name' || w === 'path' || w === 'endpoint')
    )
    if (candidates.length === 0 || !named) return { words, layers: [], chunkIds: [] }

    // 4. Deterministic re-ranking: definitions over call sites; tests demoted; connectivity to
    // other candidates (the symbol that ties the hits together); entry points.
    const ids = candidates.map((c) => c.symbolId).filter((id): id is string => Boolean(id))
    const edges = ids.length
      ? ((await trx
          .from('symbol_references')
          .where('commit_id', commitId)
          .whereIn('kind', ['call', 'new', 'route_handler', 'middleware'])
          .where((q) => q.whereIn('from_symbol_id', ids).orWhereIn('to_symbol_id', ids))
          .select('from_symbol_id', 'to_symbol_id', 'path', 'kind')) as Array<{
          from_symbol_id: string | null
          to_symbol_id: string | null
          path: string
          kind: string
        }>)
      : []
    const candidateKeys = new Set(candidates.map((c) => keyOf(c.symbolId, c.path)))
    const routeHandlers = new Set(
      edges
        .filter((e) => e.kind === 'route_handler' && e.to_symbol_id)
        .map((e) => String(e.to_symbol_id))
    )
    const routeFiles = new Set(edges.filter((e) => e.kind === 'route_handler').map((e) => e.path))
    for (const c of candidates) {
      if (DEFINITION.has(c.kind)) {
        c.score *= 1.2
        note(c, 'definition')
      }
      if (TEST_PATH.test(c.path) && !aboutTests) {
        c.score *= 0.5
        note(c, 'test')
      }
      const key = keyOf(c.symbolId, c.path)
      let connected = 0
      for (const e of edges) {
        const from = keyOf(e.from_symbol_id ? String(e.from_symbol_id) : null, e.path)
        const to = e.to_symbol_id ? String(e.to_symbol_id) : null
        if (from === key && to && to !== key && candidateKeys.has(to)) connected++
        else if (to === key && from !== key && candidateKeys.has(from)) connected++
      }
      if (connected) {
        c.score += connectionBonus(connected)
        note(c, 'connected')
      }
      if (
        (c.symbolId && routeHandlers.has(c.symbolId)) ||
        (!c.symbolId && routeFiles.has(c.path))
      ) {
        c.score += 0.5
        note(c, 'entry')
      }
      c.score = Number(c.score.toFixed(3))
    }
    const ranked = candidates
      .sort(
        (x, y) => y.score - x.score || x.path.localeCompare(y.path) || x.startLine - y.startLine
      )
      .slice(0, MAX_SYMBOLS)

    // 5. A chunk to cite for every row retrieval did not already supply.
    for (const r of ranked) {
      if (r.chunkId) continue
      const query = trx.from('chunks').where({ commit_id: commitId, path: r.path })
      if (r.symbolId) query.where('symbol_id', r.symbolId)
      const chunk = await query.orderBy('start_line').select('id').first()
      if (chunk) r.chunkId = String(chunk.id)
    }
    const cited = ranked.filter((r) => r.chunkId !== null)

    // 6. Layers by path convention, rank order kept within each.
    const byLayer = new Map<string, LocatedSymbol[]>()
    for (const r of cited)
      byLayer.set(layerOf(r.path), [...(byLayer.get(layerOf(r.path)) ?? []), r])
    const layers = [...byLayer.entries()]
      .sort((x, y) => LAYER_ORDER.indexOf(x[0]) - LAYER_ORDER.indexOf(y[0]))
      .map(([layer, list]) => ({ layer, symbols: list }))
    return { words, layers, chunkIds: cited.map((r) => r.chunkId!) }
  })
}
