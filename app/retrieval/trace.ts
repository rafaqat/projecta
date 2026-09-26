import { inScope, type Scope } from '#app/security/scope'

/**
 * "How does X work / trace a request from its entry point": the resolved
 * reference graph (tiers) walked from a symbol or from a
 * file's top level, callees first, to a bounded depth. Every edge is a
 * file:line the model can cite and carries how sure the parser was:
 * `exact`/`alias` followed a declaration or import, `heuristic` matched a
 * member by name (the reader sees it badged, the model says "likely"),
 * `external` reaches a package, `unresolved` is a call the index could not
 * place — kept by name, never dropped. Utility calls (logging, formatting,
 * assertions) are pruned from the flow and counted. From the entry: the
 * nearest route or entry file reached by walking callers is the root.
 */
export interface TraceEdge {
  from: string
  to: string
  kind: string
  resolution: string
  path: string
  line: number
  depth: number
  chunkId: string | null
}

export interface Trace {
  referencesIndexed: boolean
  root: { qualifiedName: string; path: string; startLine: number; endLine: number } | null
  /** How the root was chosen: the named symbol, or an entry found by walking its callers. */
  entry: { via: 'named' | 'callers'; hops: number } | null
  edges: TraceEdge[]
  /** Symbols reached, in discovery order, with their locations. */
  reached: Array<{ qualifiedName: string; path: string; startLine: number }>
  /** Utility calls left out of the flow. */
  pruned: number
  /** Calls at the commit no tier could place. */
  unresolved: { calls: number; files: number }
  chunkIds: string[]
}

const MAX_EDGES = 40
const WALK_KINDS = ['call', 'new', 'route_handler', 'middleware']
/** Callee names that are plumbing, not the flow: logging, formatting, assertions, type guards. */
const PRUNE =
  /^(log|logger|debug|trace|warn|info|error|console|format\w*|assert\w*|is[A-Z]\w*|to(String|JSON|Fixed)|stringify|parse|inspect)$/
const ENTRY_FILE =
  /(^|\/)(index|main|app|server|cli|bin)\.(m?[jt]sx?|cjs)$|(^|\/)AppDelegate\.swift$|(^|\/)main\.swift$|(^|\/)\w*(Activity|Application)\.kt$/

/**
 * Android starts components, not files: a lifecycle callback of an activity, fragment, service,
 * receiver, worker or the application class is where a flow begins.
 */
const ANDROID_COMPONENT = /(Activity|Application|Fragment|Service|Receiver|Worker)\.kt$/
const ANDROID_CALLBACK = /\.(on[A-Z]\w*|doWork)$/

interface Node {
  symbolId: string | null
  path: string
  name: string
  depth: number
}

export async function traceFrom(
  scope: Scope,
  commitId: string,
  named: string,
  maxDepth = 3,
  options: { fromEntry?: boolean } = {}
): Promise<Trace> {
  return inScope(scope, async (trx) => {
    const empty = (indexed: boolean, unresolved: Trace['unresolved']): Trace => ({
      referencesIndexed: indexed,
      root: null,
      entry: null,
      edges: [],
      reached: [],
      pruned: 0,
      unresolved,
      chunkIds: [],
    })
    const unresolvedRow = await trx
      .from('symbol_references')
      .where({ commit_id: commitId, resolution: 'unresolved' })
      .whereIn('kind', ['call', 'new'])
      .countDistinct('path as files')
      .count('* as calls')
      .first()
    const unresolved = {
      calls: Number(unresolvedRow?.calls ?? 0),
      files: Number(unresolvedRow?.files ?? 0),
    }
    const indexed = await trx
      .from('symbol_references')
      .where('commit_id', commitId)
      .select('id')
      .first()
    const referencesIndexed = Boolean(indexed)
    const spelled = named.trim().replace(/^\.?\//, '')
    const short = spelled.split('.').pop()!
    // A root: a declared symbol by qualified or short name, or a file's top level.
    const file = /\.[a-z0-9]{1,6}$/i.test(spelled)
      ? await trx
          .from('files')
          .where('commit_id', commitId)
          .whereNull('ignored_by')
          .where((q) => q.where('path', spelled).orWhereLike('path', `%/${spelled}`))
          .orderByRaw('case when path = ? then 0 else 1 end, path', [spelled])
          .select('path')
          .first()
      : null
    const symbol = file
      ? null
      : await trx
          .from('symbols')
          .where('commit_id', commitId)
          .whereNotIn('kind', ['region', 'import'])
          .where((q) => q.where('qualified_name', spelled).orWhere('name', short))
          .orderByRaw('case when qualified_name = ? then 0 else 1 end, path, start_line', [spelled])
          .select('id', 'qualified_name', 'path', 'start_line', 'end_line')
          .first()
    if (!file && !symbol) return empty(referencesIndexed, unresolved)

    let root: NonNullable<Trace['root']> = symbol
      ? {
          qualifiedName: String(symbol.qualified_name),
          path: String(symbol.path),
          startLine: Number(symbol.start_line),
          endLine: Number(symbol.end_line),
        }
      : { qualifiedName: '<file>', path: String(file!.path), startLine: 1, endLine: 0 }
    let start: Node = {
      symbolId: symbol ? String(symbol.id) : null,
      path: root.path,
      name: root.qualifiedName,
      depth: 0,
    }
    let entry: Trace['entry'] = { via: 'named', hops: 0 }
    if (!referencesIndexed) return { ...empty(false, unresolved), root, entry }

    // Route files: any file with a route_handler edge; route handlers: targets of one.
    const routeFiles = new Set(
      (
        (await trx
          .from('symbol_references')
          .where({ commit_id: commitId, kind: 'route_handler' })
          .distinct('path')) as Array<{ path: string }>
      ).map((r) => r.path)
    )
    const routeHandlers = new Set(
      (
        (await trx
          .from('symbol_references')
          .where({ commit_id: commitId, kind: 'route_handler' })
          .whereNotNull('to_symbol_id')
          .distinct('to_symbol_id')) as Array<{ to_symbol_id: string }>
      ).map((r) => String(r.to_symbol_id))
    )
    const isEntry = (n: Node) =>
      (n.symbolId === null && (routeFiles.has(n.path) || ENTRY_FILE.test(n.path))) ||
      (n.symbolId !== null &&
        (routeHandlers.has(n.symbolId) ||
          (ANDROID_COMPONENT.test(n.path) && ANDROID_CALLBACK.test(n.name))))

    // From the entry: walk callers, nearest first, until a route file, route handler or entry file.
    if (options.fromEntry && symbol) {
      const seen = new Set<string>([String(symbol.id)])
      let frontier: Node[] = [start]
      let found: Node | null = isEntry(start) ? start : null
      for (let hops = 1; hops <= 4 && !found && frontier.length; hops++) {
        const next: Node[] = []
        for (const node of frontier) {
          if (!node.symbolId) continue
          const callers = (await trx
            .from('symbol_references as r')
            .leftJoin('symbols as f', 'f.id', 'r.from_symbol_id')
            .where({ 'r.commit_id': commitId, 'r.to_symbol_id': node.symbolId })
            .whereIn('r.kind', WALK_KINDS)
            .orderBy(['r.path', 'r.line', 'r.kind', 'r.target_name', 'r.resolution'])
            .select('r.from_symbol_id', 'r.path', 'f.qualified_name')) as Array<{
            from_symbol_id: string | null
            path: string
            qualified_name: string | null
          }>
          for (const c of callers) {
            const key = c.from_symbol_id ? String(c.from_symbol_id) : `file:${c.path}`
            if (seen.has(key)) continue
            seen.add(key)
            const candidate: Node = {
              symbolId: c.from_symbol_id ? String(c.from_symbol_id) : null,
              path: String(c.path),
              name: c.qualified_name ? String(c.qualified_name) : '<file>',
              depth: 0,
            }
            if (isEntry(candidate)) {
              found = candidate
              entry = { via: 'callers', hops }
              break
            }
            next.push(candidate)
          }
          if (found) break
        }
        frontier = next
      }
      if (found && found !== start) {
        start = found
        const sym = found.symbolId
          ? await trx
              .from('symbols')
              .where('id', found.symbolId)
              .select('start_line', 'end_line')
              .first()
          : null
        root = {
          qualifiedName: found.name,
          path: found.path,
          startLine: sym ? Number(sym.start_line) : 1,
          endLine: sym ? Number(sym.end_line) : 0,
        }
      }
    }

    const edges: TraceEdge[] = []
    const reached: Trace['reached'] = []
    const seen = new Set<string>()
    let pruned = 0
    let frontier: Node[] = [start]
    // A file's top level includes its top-level variables: `const app = createApp()` calls from
    // the variable's own span, not from the bare region.
    if (start.symbolId === null) {
      const topLevel = (await trx
        .from('symbols')
        .where({ commit_id: commitId, path: start.path, kind: 'variable' })
        .whereNull('parent')
        .orderBy('start_line')
        .select('id', 'qualified_name')) as Array<{ id: string; qualified_name: string }>
      for (const v of topLevel)
        frontier.push({
          symbolId: String(v.id),
          path: start.path,
          name: String(v.qualified_name),
          depth: 0,
        })
    }
    while (frontier.length && edges.length < MAX_EDGES) {
      const next: Node[] = []
      for (const node of frontier) {
        const query = trx
          .from('symbol_references as r')
          .leftJoin('symbols as t', 't.id', 'r.to_symbol_id')
          .where('r.commit_id', commitId)
          .whereIn('r.kind', WALK_KINDS)
          .orderBy(['r.path', 'r.line', 'r.kind', 'r.target_name', 'r.resolution'])
          .select(
            'r.kind',
            'r.resolution',
            'r.target_name',
            'r.to_external',
            'r.path',
            'r.line',
            't.id as to_id',
            't.qualified_name',
            't.path as to_path',
            't.start_line'
          )
        if (node.symbolId) query.where('r.from_symbol_id', node.symbolId)
        else query.whereNull('r.from_symbol_id').where('r.path', node.path)
        const rows = (await query) as Array<{
          kind: string
          resolution: string
          target_name: string | null
          to_external: string | null
          path: string
          line: number
          to_id: string | null
          qualified_name: string | null
          to_path: string | null
          start_line: number | null
        }>
        for (const r of rows) {
          if (edges.length >= MAX_EDGES) break
          const to = r.qualified_name ?? r.to_external ?? r.target_name ?? '?'
          const shortName = to.split(/[.#]/).pop() ?? to
          if (PRUNE.test(shortName)) {
            pruned++
            continue
          }
          edges.push({
            from: node.name,
            to,
            kind: String(r.kind),
            resolution: String(r.resolution ?? 'exact'),
            path: String(r.path),
            line: Number(r.line),
            depth: node.depth + 1,
            chunkId: null,
          })
          if (!r.to_id) continue
          const id = String(r.to_id)
          if (seen.has(id)) continue
          seen.add(id)
          reached.push({
            qualifiedName: String(r.qualified_name),
            path: String(r.to_path),
            startLine: Number(r.start_line),
          })
          if (node.depth + 1 < maxDepth)
            next.push({
              symbolId: id,
              path: String(r.to_path),
              name: String(r.qualified_name),
              depth: node.depth + 1,
            })
        }
      }
      frontier = next
    }
    // The chunk holding each edge's site, for citations.
    const chunkIds: string[] = []
    for (const e of edges) {
      const chunk = await trx
        .from('chunks')
        .where({ commit_id: commitId, path: e.path })
        .where('start_line', '<=', e.line)
        .where('end_line', '>=', e.line)
        .select('id')
        .first()
      if (chunk) {
        e.chunkId = String(chunk.id)
        if (!chunkIds.includes(e.chunkId)) chunkIds.push(e.chunkId)
      }
    }
    return { referencesIndexed, root, entry, edges, reached, pruned, unresolved, chunkIds }
  })
}
