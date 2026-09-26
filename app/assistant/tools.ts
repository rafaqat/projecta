import db from '@adonisjs/lucid/services/db'
import type { TurnEvidence } from '#app/assistant/evidence'
import type { ContentBlock, ToolSpec } from '#app/assistant/model'
import type { ViewComponent } from '#app/assistant/protocol'
import { cloneClasses, similarSymbols } from '#app/clones/queries'
import { isValidPin } from '#app/dependencies/tier1'
import { Indexer } from '#app/ingest/indexer'
import { ParserPool } from '#app/parse/child_process'
import { retrieve } from '#app/retrieval/hybrid'
import { securityEvents } from '#app/security/events/index'
import { inScope, type Scope } from '#app/security/scope'
import { findUsages } from '#app/retrieval/usages'
import { fileOutline } from '#app/retrieval/outline'
import { repoMap } from '#app/retrieval/repo_map'
import { locate } from '#app/retrieval/locate'
import { traceFrom } from '#app/retrieval/trace'
import {
  bodyChunkIds,
  HANDLER_CHUNKS,
  namedRoutes,
  namedSymbols,
  routeHandlers,
  SUBJECT_CHUNKS,
} from '#app/retrieval/subject_code'

/**
 * Read-only tools. Scope and commit come from the
 * session-bound turn, never from model arguments; results are search-result
 * blocks addressed by turn-local handles, so the model can cite them.
 */
export type ToolResultContent = Extract<ContentBlock, { type: 'tool_result' }>['content']

export interface Tool {
  spec: ToolSpec
  run(input: unknown): Promise<ToolResultContent>
}

export interface ToolContext {
  scope: Scope
  commitId: string
  evidence: TurnEvidence
  /** Structured views are server data, never model text; the orchestrator streams them. */
  emitView?: (component: ViewComponent, data: unknown) => void
  /** Views already emitted this turn: a tool the planner pre-ran does not render its table twice. */
  emitted?: Set<ViewComponent>
  /** The set batch this turn answers: the model's own list_endpoints call gets the batch again, never the whole table. */
  batch?: { from: number; to: number | null }
}

const text = (t: string): ToolResultContent => [{ type: 'text', text: t }]
/** Tier 3 calls per turn (SEC-04): a bound on registry traffic the model can steer. */
export const TIER3_CALLS_PER_TURN = 3

/**
 * The usages of an identifier as a deterministic view and as evidence: the
 * table is emitted for the reader, and the chunks of every site (capped at
 * the evidence budget) join the turn's evidence so the model's prose about
 * them can cite them. Shared by the model's tool and by the turn itself,
 * which runs it for a "who calls X?" question before the model speaks.
 */
export async function usagesIntoEvidence(
  ctx: ToolContext,
  identifier: string,
  chunkCap = 12
): Promise<ToolResultContent> {
  const found = await findUsages(ctx.scope, ctx.commitId, identifier)
  if (found.usages.length === 0 && found.definitions.length === 0) return []
  ctx.emitView?.('usage_table', { component: 'usage_table', ...found })
  const chunkIds = [...new Set(found.usages.flatMap((u) => (u.chunkId ? [u.chunkId] : [])))].slice(
    0,
    chunkCap
  )
  // What the index proved, guessed and could not place, in words the model repeats.
  const heuristic = found.usages.filter((u) => u.resolution === 'heuristic').length
  const note = [
    `${found.usages.length} use(s) of ${identifier} at this commit${heuristic ? `, ${heuristic} matched by name only (say "likely" for those)` : ''}.`,
    found.unresolved.named.calls
      ? `${found.unresolved.named.calls} call(s) named ${identifier} in ${found.unresolved.named.files} file(s) could not be resolved to a definition: callers among them cannot be listed.`
      : `Every call named ${identifier} at this commit resolves to a listed definition.`,
    found.unresolved.calls
      ? `Separately, ${found.unresolved.calls} call(s) in ${found.unresolved.files} file(s) across the commit could not be resolved (package and browser APIs, mostly); that is a general limit of the index, not hidden callers of ${identifier}. Never say ${identifier} is unused.`
      : '',
  ].filter(Boolean)
  return [...text(note.join('\n')), ...(await ctx.evidence.addChunks(chunkIds))]
}

/**
 * The endpoint table with each row's code: the handler every route line resolves to,
 * and the handlers' bodies in evidence in table order up to the budget, so what an endpoint does
 * is described from its code. Rows past the budget are named, never described. Shared by the
 * model's tool and by the turn's planner for an endpoint question.
 */
export async function endpointsIntoEvidence(
  ctx: ToolContext,
  chunkCap = HANDLER_CHUNKS,
  /** A set question's batch: rows from `from` (1-based) until their code fills the budget. */
  batch?: { from: number; to: number | null }
): Promise<ToolResultContent> {
  const rows = await inScope(ctx.scope, (trx) =>
    trx
      .from('endpoints')
      .where('commit_id', ctx.commitId)
      .orderBy(['path', 'method'])
      .select('framework', 'method', 'path', 'file', 'line', 'handler')
  )
  if (rows.length === 0) return text('no endpoints extracted')
  const routed = await routeHandlers(
    ctx.scope,
    ctx.commitId,
    rows.map((r) => ({ method: r.method, path: r.path, file: r.file, line: Number(r.line) }))
  )
  const endpoints = rows.map((r, i) => ({
    ...r,
    handler: r.handler ?? (routed[i].handlers.map((h) => h.qualifiedName).join(', ') || null),
  }))
  // The table renders once per set: on a continuation batch the reader already has it above.
  if (!ctx.emitted?.has('endpoint_table') && !(batch && batch.from > 1)) {
    ctx.emitView?.('endpoint_table', { component: 'endpoint_table', endpoints })
    ctx.emitted?.add('endpoint_table')
  }
  // Handlers' bodies in table order, until the budget: each row's code is all in, or not at all.
  const chunkIds: string[] = []
  const withCode = new Set<number>()
  const first = Math.max(1, batch?.from ?? 1) - 1
  const last = Math.min(rows.length, batch?.to ?? rows.length) - 1
  for (const [i, row] of routed.entries()) {
    if (batch && (i < first || i > last)) continue
    if (batch && withCode.size && chunkIds.length >= chunkCap) break
    const ids = row.handlers.length
      ? await bodyChunkIds(
          ctx.scope,
          row.handlers.map((h) => h.id),
          chunkCap
        )
      : row.inlineChunkId
        ? [row.inlineChunkId]
        : []
    const fresh = ids.filter((id) => !chunkIds.includes(id))
    if (ids.length === 0 || chunkIds.length + fresh.length > chunkCap) continue
    chunkIds.push(...fresh)
    withCode.add(i)
  }
  if (batch) {
    // The batch is the rows with code, contiguous from `first`; progress is a view of its own.
    const to = withCode.size ? Math.max(...withCode) + 1 : first + 1
    const progress = {
      set: 'endpoints' as const,
      total: rows.length,
      from: first + 1,
      to,
      next: to < rows.length ? `Explain endpoints ${to + 1} to ${rows.length}` : null,
    }
    ctx.emitView?.('set_progress', { component: 'set_progress', ...progress })
    const batchLines = routed
      .map((row, i) => [row, i] as const)
      .filter(([, i]) => withCode.has(i))
      .map(
        ([row, i]) =>
          `${i + 1}. ${row.method} ${row.path} (${row.file}:${row.line}) → ${row.handlers.map((h) => h.qualifiedName).join(', ') || 'inline handler'}`
      )
    const note = [
      `Endpoints ${progress.from}–${to} of ${rows.length}. Their handlers' code follows as results.`,
      'Write one entry per endpoint, in this order, headed by its method and path exactly as listed, then one or two sentences on what its handler does, each citing the handler. No introduction, no grouping by feature, no summary of the app; describe only these endpoints; do not repeat the table.',
      progress.next
        ? `${rows.length - to} endpoint(s) remain for a later question; do not mention them.`
        : '',
    ].filter(Boolean)
    const blocks = await ctx.evidence.addChunks(chunkIds)
    return [...text([...note, ...batchLines].join('\n')), ...blocks]
  }
  const lines = routed.map((row, i) => {
    const handler = row.handlers.length
      ? row.handlers.map((h) => h.qualifiedName).join(', ')
      : row.inlineChunkId
        ? 'inline handler'
        : 'handler not resolved'
    return `${row.method} ${row.path} (${rows[i].framework}, ${row.file}:${row.line}) → ${handler}${withCode.has(i) ? '' : ' [code not in evidence]'}`
  })
  const note = [
    `${rows.length} endpoint(s). The code of the handlers of ${withCode.size} of them follows as results; describe what an endpoint does only from its handler's code and cite it.`,
    withCode.size < rows.length
      ? `${rows.length - withCode.size} endpoint(s) are marked [code not in evidence]: do not describe what they do; list them, or read a handler with read_symbol first.`
      : '',
  ].filter(Boolean)
  const blocks = await ctx.evidence.addChunks(chunkIds)
  return [...text([...note, ...lines].join('\n')), ...blocks]
}

/**
 * The code of what a question names: the bodies of the functions, methods and classes
 * it names, and of the handlers of the routes it names, before the model describes them.
 */
export async function subjectCodeIntoEvidence(
  ctx: ToolContext,
  question: string,
  anchors: string[]
): Promise<ToolResultContent> {
  const symbols = await namedSymbols(ctx.scope, ctx.commitId, anchors)
  const endpointRows = await inScope(ctx.scope, (trx) =>
    trx.from('endpoints').where('commit_id', ctx.commitId).select('method', 'path', 'file', 'line')
  )
  const routes = await routeHandlers(
    ctx.scope,
    ctx.commitId,
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
  const handlerIds = routes.flatMap((r) => r.handlers.map((h) => h.id))
  const ids = await bodyChunkIds(
    ctx.scope,
    [...new Set([...symbols.map((s) => s.id), ...handlerIds])],
    SUBJECT_CHUNKS
  )
  for (const r of routes)
    if (r.inlineChunkId && !ids.includes(r.inlineChunkId)) ids.push(r.inlineChunkId)
  if (ids.length === 0) return []
  const named = [
    ...symbols.map((s) => `${s.qualifiedName} (${s.kind}, ${s.path}:${s.startLine}-${s.endLine})`),
    ...routes.map(
      (r) =>
        `${r.method} ${r.path} → ${r.handlers.map((h) => `${h.qualifiedName} (${h.path}:${h.startLine}-${h.endLine})`).join(', ') || 'inline handler'}`
    ),
  ]
  const blocks = await ctx.evidence.addChunks(ids.slice(0, SUBJECT_CHUNKS + 3))
  return [
    ...text(
      `The code of what the question names follows as results; describe it only from this code:\n${named.join('\n')}`
    ),
    ...blocks,
  ]
}

/**
 * "Show me dependencies": the tables answer. The manifests at the
 * commit come first — read, with their row counts, or recognised and not
 * read — so an empty manifest is never taken for a self-contained
 * application; then every row with the manifest line it was read from.
 * The view is emitted for the reader, the text for the model, and the
 * manifest chunks at those lines join the evidence so a dependency the model
 * names can be cited. Shared by the model's tool and by the turn itself,
 * which runs it for an enumeration question before the model speaks.
 */
/** The card's one-line summary, computed from the rows: counts, and the packages not imported by an indexed file. */
export function dependencySummary(
  rows: Array<{ kind: string; name: string; importers: unknown; manifest?: string | null }>,
  manifests: Array<{ path: string; status: string }>
): string {
  const declared = rows.filter((r) => r.kind !== 'transitive')
  if (declared.length === 0)
    return manifests.some((m) => m.status !== 'read')
      ? 'No dependencies read: a manifest was recognised but the index has no reader for it.'
      : 'No dependencies are declared by the manifests read.'
  const direct = declared.filter((r) => r.kind === 'direct').length
  const dev = declared.filter((r) => r.kind === 'dev').length
  const imported = declared.filter((r) => Array.isArray(r.importers) && r.importers.length > 0)
  const unused = declared.filter((r) => !Array.isArray(r.importers) || r.importers.length === 0)
  const files = [...new Set(declared.map((r) => r.manifest).filter(Boolean))].join(', ')
  const parts = [
    `${direct} direct and ${dev} dev package${direct + dev === 1 ? '' : 's'} declared in ${files || 'the manifests'}`,
    `${imported.length} imported by indexed files`,
    unused.length
      ? `${unused.length} declared but not imported by any indexed file: ${unused.map((r) => r.name).join(', ')}`
      : 'every declared package is imported by an indexed file',
  ]
  return parts.join('; ') + '.'
}

export async function dependenciesIntoEvidence(
  ctx: ToolContext,
  chunkCap = 12
): Promise<ToolResultContent> {
  const { manifests, rows } = await inScope(ctx.scope, async (trx) => ({
    manifests: await trx
      .from('manifests')
      .where('commit_id', ctx.commitId)
      .orderBy('path')
      .select('path', 'ecosystem', 'status', 'dependencies'),
    rows: await trx
      .from('dependencies')
      .where('commit_id', ctx.commitId)
      .orderBy(['ecosystem', 'kind', 'name', 'manifest'])
      .select(
        'ecosystem',
        'name',
        'version',
        'kind',
        'importers',
        'tier1_status',
        'manifest',
        'line'
      ),
  }))
  if (manifests.length === 0 && rows.length === 0) return []
  ctx.emitView?.('dependency_graph', {
    component: 'dependency_graph',
    manifests,
    dependencies: rows,
    summary: dependencySummary(rows, manifests),
  })
  const lines = [
    'Manifests at this commit:',
    ...manifests.map((m) =>
      m.status === 'read'
        ? `  ${m.path} (${m.ecosystem}, ${m.dependencies} dependencies)`
        : `  ${m.path} (${m.ecosystem}, not read: the index has no reader for it)`
    ),
    rows.length
      ? 'Dependencies (each manifest line follows as a result: cite it when you name a dependency). The reader already sees this table as a card. Write at most three sentences: how many declared packages indexed files import and how many they do not, then name only the packages not imported (a template or script the index does not read may still use them). Do not list the packages in use, do not group packages by purpose or say what a package is for — its purpose is not in evidence — and stop.'
      : 'Dependencies: none declared by the manifests read.',
    ...rows.map((r) => {
      const site = r.line ? `${r.manifest}:${r.line}` : r.manifest
      const importers = (r.importers as string[]).length
        ? `; imported by ${(r.importers as string[]).join(', ')}`
        : ''
      return `  ${r.name}@${r.version} (${r.ecosystem}, ${r.kind}; ${site}${importers})`
    }),
  ]
  // The manifest lines the rows cite, as evidence: the chunk holding each declaration.
  const sites = rows.filter((r) => r.line).slice(0, chunkCap)
  const chunkIds = sites.length
    ? await inScope(ctx.scope, (trx) =>
        trx
          .from('chunks')
          .where('commit_id', ctx.commitId)
          .where((q) => {
            for (const r of sites)
              q.orWhere((w) =>
                w
                  .where('path', r.manifest)
                  .where('start_line', '<=', r.line)
                  .where('end_line', '>=', r.line)
              )
          })
          .select('id')
      ).then((r) => [...new Set(r.map((x) => x.id as string))])
    : []
  const blocks = await ctx.evidence.addChunks(chunkIds)
  return [...text(lines.join('\n')), ...blocks]
}

/**
 * "What is implemented in `<file>`?": the index answers (UAT 2026-09-15,
 * addProduct.js). The outline — the file's declarations with their lines —
 * is a view for the reader and text for the model; the file's chunks, in
 * line order up to the cap, join the evidence so every declaration the
 * model names can be cited. Shared by the model's tool and by the turn
 * itself, which runs it for a path-anchored question before the model speaks.
 */
export async function outlineIntoEvidence(
  ctx: ToolContext,
  path: string,
  chunkCap = 16
): Promise<ToolResultContent> {
  const outline = await fileOutline(ctx.scope, ctx.commitId, path)
  if (!outline.exists) return []
  ctx.emitView?.('file_outline', { component: 'file_outline', ...outline })
  // The declarations on screen verify an uncited sentence that names them.
  ctx.evidence.addOutline(outline.path, outline.symbols)
  const shown = outline.chunkIds.slice(0, chunkCap)
  const lines = [
    `Declarations in ${outline.path} (${outline.lines} lines):`,
    ...(outline.symbols.length
      ? outline.symbols.map(
          (s) => `  ${s.kind} ${s.qualifiedName} (lines ${s.startLine}–${s.endLine})`
        )
      : [
          '  none declared: the file is a region without declarations (data, configuration or a script body)',
        ]),
    shown.length < outline.chunkIds.length
      ? `The first ${shown.length} of ${outline.chunkIds.length} chunks of the file follow as results (cite them when you describe a declaration); the rest are not in evidence.`
      : `Every chunk of the file follows as a result: cite them when you describe a declaration.`,
  ]
  const blocks = await ctx.evidence.addChunks(shown)
  return [...text(lines.join('\n')), ...blocks]
}

/**
 * "How is this repository organised / what does it do / where does it start": the map
 * answers (UAT 2026-09-16). A view for the reader; the map as text for the model; the
 * README's first sections and the entry points' first chunks as citable evidence.
 */
export async function mapIntoEvidence(ctx: ToolContext): Promise<ToolResultContent> {
  const map = await repoMap(ctx.scope, ctx.commitId)
  if (map.files === 0) return []
  ctx.emitView?.('repo_map', { component: 'repo_map', ...map })
  const langs = Object.entries(map.languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([e, n]) => `${e} ${n}`)
    .join(', ')
  const unindexed = map.unindexed.map((u) => `${u.ext} ${u.files}`).join(', ')
  const lines = [
    `Repository map: ${map.files} files (${map.indexed} indexed), languages ${langs || 'none'}; ${map.endpoints} endpoints; ${map.tests.files} test files.`,
    // UAT 2026-09-16 (StyleSwap): the prose re-listed the table row by row and guessed what each
    // directory held from its name.
    'The reader sees this map as a table beside your answer: do not list the directories again. In a few sentences, describe how the parts relate — where a request enters and which layers it passes through — citing the entry-point and README results; never say what a directory holds from its name alone.',
    map.unindexed.length
      ? `Not indexed: ${map.files - map.indexed} ${map.files - map.indexed === 1 ? 'file' : 'files'} (${unindexed}); say the answer does not cover them.`
      : 'Not indexed: none.',
    map.referencesIndexed
      ? 'Calls between files: references are indexed at this commit.'
      : 'Calls between files: references are not indexed at this commit; do not describe which file calls which beyond the cited results.',
    'Directories (files, declarations):',
    ...map.directories.map((d) => `  ${d.path}/ (${d.files} files, ${d.symbols} declarations)`),
    map.entryPoints.length
      ? 'Entry points: ' + map.entryPoints.map((e) => `${e.path} (${e.why})`).join('; ')
      : 'Entry points: none recognised by manifest or name.',
    map.hubs.length
      ? 'Most referenced symbols: ' +
        map.hubs.map((h) => `${h.qualifiedName} (${h.references}, ${h.path})`).join('; ')
      : 'Most referenced symbols: references are not indexed for this commit.',
    map.mostImported.length
      ? 'Most imported modules: ' +
        map.mostImported.map((m) => `${m.module} (${m.importers} files)`).join('; ')
      : 'Most imported modules: none recorded.',
    map.manifests.length
      ? 'Manifests: ' + map.manifests.map((m) => `${m.path} (${m.status})`).join(', ')
      : 'Manifests: none.',
    map.readme
      ? `README ${map.readme.path}, sections: ${map.readme.sections.join(' · ') || 'none'} (its first sections follow as results).`
      : 'README: none at this commit.',
    "The entry points' first chunks follow as results: cite them when you describe startup.",
  ]
  const blocks = await ctx.evidence.addChunks(map.chunkIds)
  return [...text(lines.join('\n')), ...blocks]
}

/**
 * "Where is <feature> implemented?": the index ranks the files whose paths, declared names,
 * endpoints and text match the question's words, and the model narrates files it can cite
 * (UAT 2026-09-16). Nothing located is said so, in words the model can repeat.
 */
export async function locateIntoEvidence(
  ctx: ToolContext,
  question: string
): Promise<ToolResultContent> {
  const found = await locate(ctx.scope, ctx.commitId, question)
  if (found.words.length === 0) return []
  ctx.emitView?.('feature_map', { component: 'feature_map', ...found })
  const words = found.words.map((w) => `"${w}"`).join(', ')
  const lines = found.layers.length
    ? [
        `Feature map for ${words} — declarations ranked by retrieval, name, path and endpoint matches, connectivity between hits and entry points, grouped by layer (a chunk of each follows as a result: cite it when you name the symbol):`,
        ...found.layers.flatMap((l) => [
          `  ${l.layer}:`,
          ...l.symbols.map((s) => {
            const where = `${s.path}:${s.startLine}${s.endLine > s.startLine ? `–${s.endLine}` : ''}`
            const extra = s.endpoints.length ? `; ${s.endpoints.join(', ')}` : ''
            return `    ${s.qualifiedName} (${s.kind}, ${where}; ${s.why.join(', ')}${extra})`
          }),
        ]),
      ]
    : [
        `No declaration, path, endpoint or text at this commit matches ${words}: say that nothing implements it here.`,
      ]
  const blocks = await ctx.evidence.addChunks(found.chunkIds)
  return [...text(lines.join('\n')), ...blocks]
}

/**
 * "How does X work / trace a request": the reference graph walked from a symbol or an entry
 * file (tiers), callees first, as a flow_trace view and as text; every edge's
 * site joins the evidence. A commit indexed before references says so.
 */
export async function traceIntoEvidence(
  ctx: ToolContext,
  from: string,
  depth = 3,
  options: { fromEntry?: boolean } = {}
): Promise<ToolResultContent> {
  const flow = await traceFrom(ctx.scope, ctx.commitId, from, depth, options)
  if (!flow.root) return []
  ctx.emitView?.('flow_trace', { component: 'flow_trace', ...flow })
  const rootLabel =
    flow.root.qualifiedName === '<file>'
      ? `the top level of ${flow.root.path}`
      : `${flow.root.qualifiedName} (${flow.root.path}:${flow.root.startLine})`
  const badge = (r: string) =>
    r === 'heuristic'
      ? ' [heuristic: matched by name — say "likely"]'
      : r === 'external'
        ? ' [package]'
        : r === 'unresolved'
          ? ' [unresolved: the index could not place this call]'
          : ''
  const lines = [
    `Call flow from ${rootLabel}, depth ${depth}${flow.entry?.via === 'callers' ? ` (the entry reached by walking ${flow.entry.hops} caller hop(s) up from ${from})` : ''}:`,
    ...(flow.referencesIndexed
      ? flow.edges.length
        ? flow.edges.map(
            (e) =>
              `  ${'  '.repeat(e.depth - 1)}${e.from} → ${e.to} [${e.kind}]${badge(e.resolution)} at ${e.path}:${e.line}`
          )
        : [
            '  no resolved calls from here (the body calls nothing the index declares, or only package APIs).',
          ]
      : [
          '  references are not indexed for this commit: re-index to trace calls; do not infer the flow.',
        ]),
    flow.pruned
      ? `${flow.pruned} utility call(s) (logging, formatting, assertions) left out of the flow.`
      : '',
    flow.unresolved.calls
      ? `${flow.unresolved.calls} call(s) in ${flow.unresolved.files} file(s) at this commit could not be resolved: a step through them cannot be shown.`
      : '',
    flow.edges.length
      ? "The edges' sites follow as results: cite them when you describe a step."
      : '',
  ].filter(Boolean)
  const blocks = await ctx.evidence.addChunks(flow.chunkIds.slice(0, 16))
  return [...text(lines.join('\n')), ...blocks]
}

export function readOnlyTools(ctx: ToolContext): Tool[] {
  return [
    {
      spec: {
        name: 'search_code',
        description: 'Search the repository at the active commit. Returns cited search results.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', maxLength: 200 } },
          required: ['query'],
        },
      },
      async run(input) {
        const query = String((input as { query?: unknown })?.query ?? '').slice(0, 200)
        if (!query) return text('query is required')
        const result = await retrieve(ctx.scope, ctx.commitId, query)
        const blocks = await ctx.evidence.addChunks(result.chunks.map((c) => c.id))
        return blocks.length ? blocks : text('no results')
      },
    },
    {
      spec: {
        name: 'read_symbol',
        description: 'Read the full source of the symbol that contains a search result handle.',
        inputSchema: {
          type: 'object',
          properties: { handle: { type: 'string', pattern: '^r[0-9]{1,4}$' } },
          required: ['handle'],
        },
      },
      async run(input) {
        const handle = String((input as { handle?: unknown })?.handle ?? '')
        const ids = await inScope(ctx.scope, async (trx) => {
          const chunk = await trx
            .from('chunks')
            .where('id', chunkIdOf(ctx.evidence, handle) ?? '')
            .first()
          if (!chunk?.symbol_id) return []
          const rows = await trx
            .from('chunks')
            .where('symbol_id', chunk.symbol_id)
            .orderBy('start_line')
            .select('id')
          return rows.map((r) => r.id as string)
        })
        const blocks = await ctx.evidence.addChunks(ids)
        return blocks.length ? blocks : text('unknown handle')
      },
    },
    {
      spec: {
        name: 'find_usages',
        description:
          'Every reference to an identifier the parser resolved at the active commit — calls, constructions and reads from other symbols, through imports — with the enclosing symbol, and what the identifier itself calls; the sites become citable results.',
        inputSchema: {
          type: 'object',
          properties: { identifier: { type: 'string', pattern: '^[A-Za-z_$][\\w$]{0,199}$' } },
          required: ['identifier'],
        },
      },
      async run(input) {
        const identifier = String((input as { identifier?: unknown })?.identifier ?? '')
        if (!/^[A-Za-z_$][\w$]{0,199}$/.test(identifier)) return text('not an identifier')
        const blocks = await usagesIntoEvidence(ctx, identifier)
        return blocks.length ? blocks : text(`no use of ${identifier} at this commit`)
      },
    },
    {
      spec: {
        name: 'file_outline',
        description:
          'The declarations of a file at the active commit (kind, name, lines) and its chunks in line order as citable results; a bare file name resolves to its path.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', maxLength: 1024 } },
          required: ['path'],
        },
      },
      async run(input) {
        const path = String((input as { path?: unknown })?.path ?? '').slice(0, 1024)
        if (!path) return text('path is required')
        const blocks = await outlineIntoEvidence(ctx, path)
        return blocks.length ? blocks : text(`no file named ${path} at this commit`)
      },
    },
    {
      spec: {
        name: 'repo_map',
        description:
          'The map of the repository at the active commit: directories with file and declaration counts, entry points, the most referenced symbols and most imported modules, endpoints, manifests, the README sections; the README and entry points become citable results.',
        inputSchema: { type: 'object', properties: {} },
      },
      async run() {
        const blocks = await mapIntoEvidence(ctx)
        return blocks.length ? blocks : text('no files at this commit')
      },
    },
    {
      spec: {
        name: 'locate',
        description:
          'The declarations at the active commit that implement a feature named by words: retrieval rolled up to symbols, re-ranked by name, path and endpoint matches, connectivity between hits and entry points, grouped by architectural layer; each with a citable result.',
        inputSchema: {
          type: 'object',
          properties: {
            words: { type: 'array', items: { type: 'string', maxLength: 60 }, maxItems: 8 },
          },
          required: ['words'],
        },
      },
      async run(input) {
        const words = ((input as { words?: unknown })?.words as unknown[] | undefined) ?? []
        const question = words
          .map((w) => String(w))
          .join(' ')
          .slice(0, 300)
        if (!question) return text('words are required')
        const blocks = await locateIntoEvidence(ctx, question)
        return blocks.length ? blocks : text('nothing located')
      },
    },
    {
      spec: {
        name: 'trace',
        description:
          'The call flow from a symbol or an entry file at the active commit: the references the parser resolved, callees first, to a bounded depth, each edge a citable file:line.',
        inputSchema: {
          type: 'object',
          properties: {
            from: { type: 'string', maxLength: 300 },
            depth: { type: 'integer', minimum: 1, maximum: 4 },
          },
          required: ['from'],
        },
      },
      async run(input) {
        const from = String((input as { from?: unknown })?.from ?? '').slice(0, 300)
        const depth = Number((input as { depth?: unknown })?.depth ?? 3)
        if (!from) return text('from is required')
        const blocks = await traceIntoEvidence(ctx, from, Math.min(4, Math.max(1, depth || 3)))
        return blocks.length ? blocks : text(`no symbol or file named ${from} at this commit`)
      },
    },
    {
      spec: {
        name: 'read_code',
        description:
          'Read the full code of named functions, methods or classes, or of the handlers of named route paths (such as /orders/:id), before describing what they do.',
        inputSchema: {
          type: 'object',
          properties: {
            names: {
              type: 'array',
              items: { type: 'string', maxLength: 256 },
              maxItems: 3,
            },
          },
          required: ['names'],
        },
      },
      async run(input) {
        const names = (input as { names?: unknown })?.names ?? []
        const list = Array.isArray(names) ? names.map(String).slice(0, 3) : []
        const content = await subjectCodeIntoEvidence(ctx, list.join(' '), list)
        return content.length
          ? content
          : text(`no function, method, class or route named ${list.join(', ')} at this commit`)
      },
    },
    {
      spec: {
        name: 'list_endpoints',
        description:
          "List the HTTP endpoints extracted at the active commit (method, path, file, line), each with its handler, and put the handlers' code in evidence.",
        inputSchema: { type: 'object', properties: {} },
      },
      async run() {
        // On a batch turn the model asked for the whole table anyway (UAT 2026-09-17: it then
        // listed all 114 from their names); it gets the batch it was given.
        return endpointsIntoEvidence(ctx, undefined, ctx.batch)
      },
    },
    {
      spec: {
        name: 'dependency_graph',
        description:
          'Every dependency declared by every manifest at the active commit (package.json, build.gradle, pom.xml, requirements, go.mod, Cargo.toml, Gemfile, Package.swift), each with its manifest line, and the manifests the index recognised but could not read; the manifest lines become citable results.',
        inputSchema: { type: 'object', properties: {} },
      },
      async run() {
        const blocks = await dependenciesIntoEvidence(ctx)
        return blocks.length ? blocks : text('no manifests at this commit')
      },
    },
    tier3Tool(ctx),
    {
      spec: {
        name: 'find_duplicates',
        description:
          'Clone classes at the active commit (inconsistent near misses first), or code similar to the symbol behind a search result handle across the workspace.',
        inputSchema: {
          type: 'object',
          properties: { handle: { type: 'string', pattern: '^r[0-9]{1,4}$' } },
        },
      },
      async run(input) {
        const handle = String((input as { handle?: unknown })?.handle ?? '')
        if (handle) {
          const anchor = await inScope(ctx.scope, async (trx) => {
            const chunk = await trx
              .from('chunks')
              .where('id', chunkIdOf(ctx.evidence, handle) ?? '')
              .first()
            if (!chunk?.symbol_id) return null
            return trx.from('symbols').where('id', chunk.symbol_id).first()
          })
          if (!anchor) return text('unknown handle')
          const similar = await similarSymbols(
            ctx.scope,
            ctx.commitId,
            anchor.path,
            anchor.qualified_name
          )
          if (similar.length === 0) return text('no similar code in this workspace')
          return text(
            similar
              .map(
                (s) =>
                  `${s.repositoryName} ${s.path}:${s.startLine}-${s.endLine} ${s.qualifiedName}`
              )
              .join('\n')
          )
        }
        const classes = await cloneClasses(ctx.scope, ctx.commitId)
        if (classes.length === 0) return text('no clone classes at this commit')
        ctx.emitView?.('clone_class', { component: 'clone_class', classes })
        return text(
          classes
            .map(
              (c) =>
                `type ${c.type} ${c.classification} (${c.method}, similarity ${c.similarity.toFixed(2)}): ` +
                c.members
                  .map((m) => `${m.path}:${m.startLine}-${m.endLine} ${m.qualifiedName}`)
                  .join(' | ')
            )
            .join('\n')
        )
      },
    },
  ]
}

/**
 * Tier 3 (SEC-04): one dependency symbol at the locked version, only
 * for packages in the commit's dependency table, fetched lazily by
 * `name@version` and returned as dependency-namespace text that can never be
 * cited as repository evidence.
 */
function tier3Tool(ctx: ToolContext): Tool {
  let calls = 0
  return {
    spec: {
      name: 'dependency_symbol',
      description:
        'Read the declaration of one exported symbol of a dependency at the version locked in this commit. Dependency text is background, not repository evidence.',
      inputSchema: {
        type: 'object',
        properties: {
          package: { type: 'string', maxLength: 214 },
          symbol: { type: 'string', maxLength: 128 },
        },
        required: ['package', 'symbol'],
      },
    },
    async run(input) {
      const pkg = String((input as { package?: unknown })?.package ?? '').slice(0, 214)
      const symbol = String((input as { symbol?: unknown })?.symbol ?? '').slice(0, 128)
      if (++calls > TIER3_CALLS_PER_TURN)
        return text(`dependency_symbol limit of ${TIER3_CALLS_PER_TURN} calls per turn reached`)
      const locked = await inScope(ctx.scope, (trx) =>
        trx
          .from('dependencies')
          .where({ commit_id: ctx.commitId, name: pkg, ecosystem: 'npm' })
          .first()
      )
      if (!locked || !isValidPin(locked.name, locked.version)) {
        securityEvents.emit('policy.enforced', {
          rule: 'dependency.outside_lockfile',
          decision: 'blocked',
        })
        return text(`${pkg} is not a dependency of this commit`)
      }
      if (!['ok', 'cached'].includes(locked.tier1_status)) {
        const pool = new ParserPool()
        try {
          const status = await new Indexer().tier1(
            locked.name,
            locked.version,
            locked.integrity,
            pool
          )
          await inScope(ctx.scope, (trx) =>
            trx.from('dependencies').where('id', locked.id).update({ tier1_status: status })
          )
          if (status !== 'ok' && status !== 'cached')
            return text(`${pkg}@${locked.version}: API surface unavailable (${status})`)
        } finally {
          pool.close()
        }
      }
      const rows = await db
        .from('dependency_symbols')
        .where({ package: locked.name, version: locked.version })
        .where((q) =>
          q.where('name', symbol).orWhereRaw('name like ?', [`%.${symbol.replace(/[%_]/g, '')}`])
        )
        .orderBy('name')
        .limit(5)
      if (rows.length === 0)
        return text(`${pkg}@${locked.version} exports no symbol named ${symbol}`)
      return text(
        rows
          .map(
            (r) => `[dependency ${r.package}@${r.version}] ${r.path}:${r.line}\n${r.declaration}`
          )
          .join('\n\n')
      )
    },
  }
}

function chunkIdOf(evidence: TurnEvidence, handle: string): string | undefined {
  return evidence.resolve(handle)?.chunkId
}
