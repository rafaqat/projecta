import { inScope, type Scope } from '#app/security/scope'
import { scopePolicy } from '#app/retrieval/router'
import { featureWords, locate } from '#app/retrieval/locate'
import { repoMap } from '#app/retrieval/repo_map'
import {
  bodyChunkIds,
  namedRoutes,
  namedSymbols,
  routeHandlers,
  BODY_CHUNKS_PER_SYMBOL,
  type SubjectSymbol,
} from '#app/retrieval/subject_code'

/**
 * The evidence pack: what the question names (seeds), expanded through the index's
 * links the same way for every question — body, callees, callers, handler, manifest lines, the
 * containing file's outline — within one budget, bodies first, then relations round-robin across
 * seeds. Nothing here looks at the question's shape. Every item carries the relation and the
 * seed it came from, for the block title.
 */
export type Relation =
  'body' | 'callee' | 'caller' | 'handler' | 'manifest' | 'outline' | 'located' | 'map'

export interface PackItem {
  chunkId: string
  relation: Relation
  seed: string
}

export interface Seed {
  name: string
  symbols: SubjectSymbol[]
  /** For a route seed, its handlers (already among `symbols`); for a package seed, the package name. */
  kind: 'symbol' | 'route' | 'package' | 'feature' | 'map'
}

export interface EvidencePack {
  seeds: Seed[]
  items: PackItem[]
  /** How the seeds were found: named, located from feature words, or the map (no seeds). */
  seedSource: 'named' | 'located' | 'map' | 'none'
}

interface Links {
  callees: Map<string, string[]>
  callers: Map<string, string[]>
}

const RELATION_ORDER: Relation[] = ['callee', 'caller', 'outline', 'manifest']

/** Seeds: the anchors and routes the question names; else located files; else the map. */
export async function findSeeds(
  scope: Scope,
  commitId: string,
  question: string,
  anchors: string[],
  packages: string[]
): Promise<{ seeds: Seed[]; source: EvidencePack['seedSource']; fallbackChunkIds: string[] }> {
  const spelled = question.match(/[A-Za-z_$][\w$.]*/g) ?? []
  const names = anchors
    .filter((a) => !a.includes('/'))
    .map((a) => spelled.find((w) => w.toLowerCase() === a.toLowerCase()) ?? a)
  const symbols = await namedSymbols(scope, commitId, names, 3)
  const seeds: Seed[] = symbols.map((s) => ({
    name: s.qualifiedName,
    symbols: [s],
    kind: 'symbol',
  }))
  const endpointRows = await inScope(scope, (trx) =>
    trx.from('endpoints').where('commit_id', commitId).select('method', 'path', 'file', 'line')
  )
  const routes = await routeHandlers(
    scope,
    commitId,
    namedRoutes(
      question,
      endpointRows.map((r) => ({
        method: r.method,
        path: r.path,
        file: r.file,
        line: Number(r.line),
      }))
    ).slice(0, 3)
  )
  for (const r of routes)
    seeds.push({ name: `${r.method} ${r.path}`, symbols: r.handlers, kind: 'route' })
  const lower = new Set(packages.map((p) => p.toLowerCase()))
  for (const a of anchors)
    if (lower.has(a.toLowerCase()) && !seeds.some((s) => s.name === a))
      seeds.push({ name: a, symbols: [], kind: 'package' })
  if (seeds.length > 0) return { seeds, source: 'named', fallbackChunkIds: [] }
  // Nothing named: the files the feature words locate, or the map when there are no words.
  if (featureWords(question).length > 0) {
    const located = await locate(scope, commitId, question)
    if (located.chunkIds.length > 0)
      return {
        seeds: [{ name: featureWords(question).join(' '), symbols: [], kind: 'feature' }],
        source: 'located',
        fallbackChunkIds: located.chunkIds,
      }
  }
  const map = await repoMap(scope, commitId)
  return map.chunkIds.length > 0
    ? {
        seeds: [{ name: 'repository', symbols: [], kind: 'map' }],
        source: 'map',
        fallbackChunkIds: map.chunkIds,
      }
    : { seeds: [], source: 'none', fallbackChunkIds: [] }
}

/** One hop of resolved references from and to the seeds' symbols, callees and callers by symbol id. */
async function linksOf(scope: Scope, commitId: string, symbolIds: string[]): Promise<Links> {
  const callees = new Map<string, string[]>()
  const callers = new Map<string, string[]>()
  if (symbolIds.length === 0) return { callees, callers }
  const rows = await inScope(scope, (trx) =>
    trx
      .from('symbol_references')
      .where('commit_id', commitId)
      .whereIn('kind', ['call', 'new', 'route_handler', 'middleware'])
      .whereNotNull('to_symbol_id')
      .where((q) => q.whereIn('from_symbol_id', symbolIds).orWhereIn('to_symbol_id', symbolIds))
      // Exact resolutions first (tiers), then by line: the first links are the surest.
      .orderByRaw("case resolution when 'exact' then 0 when 'alias' then 1 else 2 end, line")
      .select('from_symbol_id', 'to_symbol_id')
  )
  for (const r of rows) {
    const from = r.from_symbol_id ? String(r.from_symbol_id) : null
    const to = String(r.to_symbol_id)
    if (from && symbolIds.includes(from) && to !== from)
      callees.set(from, [...new Set([...(callees.get(from) ?? []), to])])
    if (symbolIds.includes(to) && from && from !== to)
      callers.set(to, [...new Set([...(callers.get(to) ?? []), from])])
  }
  return { callees, callers }
}

/** The chunks of a file's declarations in line order, for the outline relation. */
async function outlineChunkIds(scope: Scope, commitId: string, path: string, cap: number) {
  const rows = await inScope(scope, (trx) =>
    trx
      .from('chunks')
      .where({ commit_id: commitId, path })
      .orderBy('start_line')
      .limit(cap)
      .select('id')
  )
  return rows.map((r) => String(r.id))
}

/** Manifest files whose lines declare a package; `?` is bound, never inlined, so knex does not read it as a placeholder. */
const MANIFEST_PATH =
  '(^|/)(package\\.json|Package\\.swift|build\\.gradle(\\.kts)?|pom\\.xml|requirements\\.txt|pyproject\\.toml|Gemfile|go\\.mod|Cargo\\.toml)$'

async function manifestChunkIds(scope: Scope, commitId: string, pkg: string, cap: number) {
  const rows = await inScope(scope, (trx) =>
    trx
      .from('chunks')
      .where('commit_id', commitId)
      .whereRaw('path ~ ?', [MANIFEST_PATH])
      .whereRaw('position(? in text) > 0', [pkg])
      .orderBy(['path', 'start_line'])
      .limit(cap)
      .select('id')
  )
  return rows.map((r) => String(r.id))
}

/**
 * Builds the pack: every seed's body first (caps), then, round-robin across seeds and
 * relations, callees, callers, the containing file's outline and manifest lines, until the
 * budget. A chunk appears once, under the first relation that reached it.
 */
export async function buildEvidencePack(
  scope: Scope,
  commitId: string,
  question: string,
  anchors: string[],
  packages: string[],
  budget = scopePolicy().budgets.pack ?? 24
): Promise<EvidencePack> {
  const { seeds, source, fallbackChunkIds } = await findSeeds(
    scope,
    commitId,
    question,
    anchors,
    packages
  )
  const items: PackItem[] = []
  const seen = new Set<string>()
  const perFile = new Map<string, number>()
  const maxPerFile = scopePolicy().budgets.maxChunksPerFile
  const pathOf = new Map<string, string>()
  const add = (chunkId: string, relation: Relation, seed: string, path?: string) => {
    if (items.length >= budget || seen.has(chunkId)) return false
    if (path) {
      const n = perFile.get(path) ?? 0
      if (relation !== 'body' && n >= maxPerFile) return false
      perFile.set(path, n + 1)
    }
    seen.add(chunkId)
    items.push({ chunkId, relation, seed })
    return true
  }
  if (source === 'located' || source === 'map') {
    for (const id of fallbackChunkIds) add(id, source === 'map' ? 'map' : 'located', seeds[0].name)
    return { seeds, items, seedSource: source }
  }
  if (seeds.length === 0) return { seeds, items, seedSource: 'none' }

  // Bodies first: the seed's own symbols, and a route's handlers under the handler relation.
  for (const seed of seeds)
    for (const s of seed.symbols) {
      pathOf.set(s.id, s.path)
      for (const id of await bodyChunkIds(scope, [s.id], BODY_CHUNKS_PER_SYMBOL))
        add(id, seed.kind === 'route' ? 'handler' : 'body', seed.name, s.path)
    }
  if (items.length >= budget) return { seeds, items, seedSource: source }

  const symbolIds = seeds.flatMap((s) => s.symbols.map((x) => x.id))
  const links = await linksOf(scope, commitId, symbolIds)
  const linkedIds = [...new Set([...links.callees.values(), ...links.callers.values()].flat())]
  const linked = linkedIds.length
    ? await inScope(scope, (trx) =>
        trx.from('symbols').whereIn('id', linkedIds).select('id', 'path')
      )
    : []
  for (const l of linked) pathOf.set(String(l.id), String(l.path))
  // Each relation of each seed is a queue of chunk ids; rounds take one from each in turn.
  const queues: Array<{ seed: string; relation: Relation; ids: string[]; symbolId?: string }> = []
  for (const seed of seeds) {
    const own = seed.symbols.map((s) => s.id)
    const callees = [...new Set(own.flatMap((id) => links.callees.get(id) ?? []))]
    const callers = [...new Set(own.flatMap((id) => links.callers.get(id) ?? []))]
    queues.push({
      seed: seed.name,
      relation: 'callee',
      ids: await bodyChunkIds(scope, callees, budget, 2),
    })
    queues.push({
      seed: seed.name,
      relation: 'caller',
      ids: await bodyChunkIds(scope, callers, budget, 2),
    })
    const files = [...new Set(seed.symbols.map((s) => s.path))]
    const outlines = await Promise.all(files.map((f) => outlineChunkIds(scope, commitId, f, 4)))
    queues.push({ seed: seed.name, relation: 'outline', ids: outlines.flat() })
    if (seed.kind === 'package')
      queues.push({
        seed: seed.name,
        relation: 'manifest',
        ids: await manifestChunkIds(scope, commitId, seed.name, 3),
      })
  }
  const chunkPaths = new Map<string, string>()
  const allIds = [...new Set(queues.flatMap((q) => q.ids))]
  if (allIds.length) {
    const rows = await inScope(scope, (trx) =>
      trx.from('chunks').whereIn('id', allIds).select('id', 'path')
    )
    for (const r of rows) chunkPaths.set(String(r.id), String(r.path))
  }
  let progress = true
  while (items.length < budget && progress) {
    progress = false
    for (const relation of RELATION_ORDER)
      for (const q of queues.filter((x) => x.relation === relation))
        while (q.ids.length) {
          const id = q.ids.shift()!
          if (add(id, q.relation, q.seed, chunkPaths.get(id))) {
            progress = true
            break
          }
        }
  }
  return { seeds, items, seedSource: source }
}

/** The title prefix a pack item carries: the relation and the seed it came from. */
export function relationLabel(item: PackItem): string {
  const words: Record<Relation, string> = {
    body: 'body of',
    callee: 'called by',
    caller: 'calls',
    handler: 'handler of',
    manifest: 'declares',
    outline: 'same file as',
    located: 'located for',
    map: 'map of',
  }
  return `${words[item.relation]} ${item.seed}`
}
