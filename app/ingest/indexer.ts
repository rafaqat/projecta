import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { watchPeakRss } from '#app/ingest/peak_memory'
import { readFileSync } from 'node:fs'
import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { MODE_SYMLINK } from '#app/ingest/object_reader'
import { chunkSymbols, CHUNKER_VERSION } from '#app/parse/chunker'
import { ParserPool } from '#app/parse/child_process'
import {
  defaultEmbedder,
  embedBatchOptions,
  embedInBatches,
  toVectorLiteral,
  type Embedder,
} from '#app/parse/embedder'
import { defaultInjectionDetector, type InjectionDetector } from '#app/parse/injection'
import { classifiableText, scanWindows, SCAN_VERSION } from '#app/parse/prose'
import {
  grammarFor,
  parseSource,
  SCANNER_GRAMMARS,
  type GrammarId,
  type ParseResult,
} from '#app/parse/parser'
import { extractRepoFacts } from '#app/parse/profiles/node_facts'
import { NODE_SYMBOLS_VERSION } from '#app/parse/profiles/node_symbols'
import { moduleResolver } from '#app/parse/profiles/member_references'
import { isSwiftPlatform } from '#app/parse/profiles/swift_references'
import { kotlinPlatformOf } from '#app/parse/profiles/kotlin_references'
import { fetchPackageSurface, registryConfig } from '#app/dependencies/tier1'
import { cloneConfig, detectClones, signatureBands } from '#app/clones/detector'
import { buildSearchText } from '#app/retrieval/search_text'
import { derivationKey, workspaceKey } from '#app/security/derivation_keys'
import { inScope, type Scope } from '#app/security/scope'

const packageVersion = (name: string) =>
  (JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')) as { version: string })
    .version
const GRAMMAR_VERSION = `wts${packageVersion('web-tree-sitter')}+vsc${packageVersion('@vscode/tree-sitter-wasm')}`

/** Flagged spans recorded per commit, so the ingest record stays small on a noisy repository. */
const MAX_FLAGGED_SPANS = 50

/** Grammars whose files share one namespace: names resolve across the commit. */
const MODULE_GRAMMARS = new Set<GrammarId>(['swift', 'kotlin'])

/**
 * A file's view of the outside: what is the platform's, and how a type outside the module is
 * named on an external edge. Swift infers the package from the file's one non-platform import;
 * Kotlin's imports name the package exactly.
 */
function outsideOf(
  grammar: GrammarId,
  parsed: { symbols: Array<{ kind: string; name: string; parent: string | null }> }
): { isPlatform: (name: string) => boolean; externalName: (name: string) => string } {
  if (grammar === 'kotlin') {
    const header = parsed.symbols.find((s) => s.kind === 'region' && s.name === 'header')
    const imports = new Map(
      parsed.symbols.filter((s) => s.kind === 'import').map((s) => [s.name, s.parent ?? ''])
    )
    return {
      isPlatform: kotlinPlatformOf(parsed.symbols as never, header?.parent ?? null),
      externalName: (name) => (imports.has(name) ? `${imports.get(name)}#${name}` : name),
    }
  }
  const imports = parsed.symbols
    .filter((s) => s.kind === 'import' && !isSwiftPlatform(s.name))
    .map((s) => s.name)
  return {
    isPlatform: isSwiftPlatform,
    externalName: (name) =>
      imports.length === 1 && !isSwiftPlatform(name) ? `${imports[0]}#${name}` : name,
  }
}
const FACT_FILES = ['package.json', 'package-lock.json', 'tsconfig.json']
const EXTRACT_TIMEOUT_MS = 5000
/** Tier 1 is fetched for direct and dev dependencies only; transitive packages wait for a Tier 3 call. */
const TIER1_KINDS = new Set(['direct', 'dev'])

/** `symbols.name` is varchar(512). */
const SYMBOL_NAME_MAX = 512

/**
 * A symbol's name as stored: held to the column, visibly cut. A real repository's heading can be a
 * paragraph long, and one over-long name failed a whole ingest (WP-24, addyosmani/agent-skills);
 * the qualified name, which is text, keeps the whole thing for lookups.
 */
export function symbolName(name: string): string {
  return name.length <= SYMBOL_NAME_MAX ? name : `${name.slice(0, SYMBOL_NAME_MAX - 1)}…`
}

export interface IndexOutcome {
  filesParsed: number
  filesCopied: number
  filesSkipped: Record<string, number>
  symbols: number
  chunks: number
  embeddingsComputed: number
  embeddingsCached: number
  flagged: number
  /**
   * Where the flags are: path and line range, capped. A count alone is not actionable — a reader
   * who sees "flagged 6" cannot look (owner, 2026-09-18). Spans only, never the text.
   */
  flaggedSpans: Array<{ path: string; start: number; end: number }>
  endpoints: number
  /** Resolved references written. */
  references: number
  dependencies: number
  tier1: Record<string, number>
  cloneClasses: number
  /** Peak resident memory of the ingesting process while indexing ('s ceiling). */
  peakRssBytes: number
}

interface FileRow {
  path: string
  blob_sha: string
  change: string
  content: string | null
  skip_reason: string | null
  mode: string
}

/**
 * Index step (design §4): parse in the child, chunk, embed and store per
 * commit. Unchanged files copy their rows from the previous active commit;
 * everything else is derived, with parse results and embeddings cached under
 * workspace-keyed derivation keys. Plants the workspace honeytoken.
 */
/** Where the index step is: the file being derived, then the two whole-commit passes. */
export interface IndexProgress {
  phase: 'files' | 'references' | 'extract' | 'clones'
  done: number
  total: number
  /** The file being derived, during the `files` phase. */
  path?: string
  /** Everything counted so far (a copy of the running outcome). */
  counts: IndexOutcome
}

export class Indexer {
  constructor(
    private readonly options: {
      embedder?: () => Promise<Embedder>
      detector?: InjectionDetector
      parserEntry?: string
      parseTimeoutMs?: number
    } = {}
  ) {}

  async index(
    scope: Scope,
    commitId: string,
    previousCommitId: string | null,
    onProgress: (progress: IndexProgress) => void = () => {}
  ): Promise<IndexOutcome> {
    const workspaceId = scope.workspaceId!
    const key = workspaceKey(workspaceId)
    const embedder = await (this.options.embedder ?? defaultEmbedder)()
    const detector = this.options.detector ?? defaultInjectionDetector()
    // A remote detector's identity (its backend) must be known before it keys a cache entry.
    await detector.prepare?.()
    const pool = new ParserPool(this.options.parserEntry)
    const memory = watchPeakRss()
    const outcome: IndexOutcome = {
      filesParsed: 0,
      filesCopied: 0,
      filesSkipped: {},
      symbols: 0,
      chunks: 0,
      embeddingsComputed: 0,
      embeddingsCached: 0,
      flagged: 0,
      flaggedSpans: [],
      endpoints: 0,
      references: 0,
      dependencies: 0,
      tier1: {},
      cloneClasses: 0,
      peakRssBytes: 0,
    }

    try {
      const files = (await inScope(scope, (trx) =>
        trx
          .from('files')
          .join('blobs', function () {
            this.on('blobs.blob_sha', 'files.blob_sha').andOn(
              'blobs.workspace_id',
              'files.workspace_id'
            )
          })
          .where({ 'files.workspace_id': scope.workspaceId!, 'files.commit_id': commitId })
          // Ignored paths have no blob of their own; a blob of the same content reached through
          // another path must not bring them back.
          .whereNull('files.ignored_by')
          .select(
            'files.path',
            'files.blob_sha',
            'files.change',
            'files.mode',
            'blobs.content',
            'blobs.skip_reason'
          )
          // Byte order of the path, independent of the database locale: the progress index
          // then says which files are done and which remain.
          .orderByRaw('files.path collate "C"')
      )) as FileRow[]

      await inScope(scope, async (trx) => {
        await trx.from('symbol_references').where('commit_id', commitId).delete()
        await trx.from('chunks').where('commit_id', commitId).delete()
        await trx.from('symbols').where('commit_id', commitId).delete()
        await this.storeFacts(trx, workspaceId, commitId, files)
      })

      let done = 0
      const report = (progress: Omit<IndexProgress, 'counts'>) =>
        onProgress({ ...progress, counts: structuredClone(outcome) })
      report({ phase: 'files', done, total: files.length })
      for (const file of files) {
        report({ phase: 'files', done: done++, total: files.length, path: file.path })
        if (file.skip_reason || file.content === null) {
          outcome.filesSkipped[file.skip_reason ?? 'no_content'] =
            (outcome.filesSkipped[file.skip_reason ?? 'no_content'] ?? 0) + 1
          continue
        }
        // A symlink's blob is its target path, not content: skipped and named, never refused (BL-22).
        if (file.mode === MODE_SYMLINK) {
          outcome.filesSkipped.symlink = (outcome.filesSkipped.symlink ?? 0) + 1
          continue
        }
        if (!grammarFor(file.path)) {
          outcome.filesSkipped.unsupported_language =
            (outcome.filesSkipped.unsupported_language ?? 0) + 1
          continue
        }
        if (
          file.change === 'unchanged' &&
          previousCommitId &&
          (await this.copyFromPrevious(
            scope,
            key,
            previousCommitId,
            commitId,
            file,
            embedder,
            outcome
          ))
        ) {
          outcome.filesCopied++
          continue
        }
        await this.deriveFile(scope, key, commitId, file, pool, embedder, detector, outcome)
      }
      report({ phase: 'files', done: files.length, total: files.length })
      report({ phase: 'references', done: 0, total: 1 })
      await this.linkReferences(scope, key, workspaceId, commitId, files, pool, outcome)
      report({ phase: 'extract', done: 0, total: 1 })
      await this.extract(scope, workspaceId, commitId, files, pool, outcome)
      report({ phase: 'clones', done: 0, total: 1 })
      await this.detectClones(scope, workspaceId, commitId, files, pool, outcome)
      await this.plantHoneytoken(workspaceId, embedder)
      report({ phase: 'clones', done: 1, total: 1 })
      outcome.peakRssBytes = memory.stop()
      return outcome
    } finally {
      memory.stop()
      pool.close()
    }
  }

  /**
   * References: every parsed file's resolved references, joined to
   * the commit's symbols once all are in — a call in this file to a symbol of
   * this file, or through an import to a symbol of the module the specifier
   * names. A module the commit does not hold (a package) keeps the external
   * name and no target. Parses come from the derivation cache (every derived
   * or copied file has one); a file without one is parsed again.
   */
  private async linkReferences(
    scope: Scope,
    key: Buffer,
    workspaceId: string,
    commitId: string,
    files: FileRow[],
    pool: ParserPool,
    outcome: IndexOutcome
  ) {
    const symbols = await inScope(scope, (trx) =>
      trx
        .from('symbols')
        .where('commit_id', commitId)
        .whereNotIn('kind', ['region', 'import'])
        .orderBy(['path', 'start_line'])
        .select('id', 'path', 'qualified_name')
    )
    const byPathName = new Map<string, string>()
    // Overloads (Swift `set(radius:)` / `set(font:)`) share a qualified name in one file: the
    // first declared is the target and the edge is heuristic.
    const overloaded = new Set<string>()
    for (const s of symbols) {
      const at = `${s.path}|${s.qualified_name}`
      if (byPathName.has(at)) overloaded.add(at)
      else byPathName.set(at, String(s.id))
    }
    // Module-wide names for grammars whose files share one namespace (Swift).
    const byQualifiedName = new Map<string, string[]>()
    for (const s of symbols)
      byQualifiedName.set(String(s.qualified_name), [
        ...(byQualifiedName.get(String(s.qualified_name)) ?? []),
        String(s.id),
      ])
    const paths = new Set(files.map((f) => f.path))
    // tsconfig path aliases (`@services/*` → `src/services/*`) from the commit's facts.
    const facts = await inScope(scope, (trx) =>
      trx.from('repo_facts').where('commit_id', commitId).select('facts').first()
    )
    const aliases = ((facts?.facts as { tsconfigPaths?: Record<string, string[]> } | undefined)
      ?.tsconfigPaths ?? {}) as Record<string, string[]>
    const defaultExports = new Map<string, string | null>()
    const rows: Array<Record<string, unknown>> = []
    const parses = new Map<string, Awaited<ReturnType<Indexer['parsedOf']>>>()
    for (const file of files) {
      if (file.skip_reason || file.content === null || file.mode === MODE_SYMLINK) continue
      const grammar = grammarFor(file.path)
      if (!grammar || SCANNER_GRAMMARS.has(grammar)) continue
      parses.set(file.path, await this.parsedOf(scope, key, file, pool))
    }
    // Swift and Kotlin resolve across the module: properties' declared types
    // (`Order.sku` → `String`) and each class's superclass, so a member is looked up along the
    // chain of superclasses across files — a chain that reaches a type outside the module
    // without declaring the member means the member is the platform's: no reference, no gap.
    const declaredTypes = new Map<string, string>()
    const superOf = new Map<string, string>()
    for (const [path, parsed] of parses) {
      if (!MODULE_GRAMMARS.has(grammarFor(path)!) || parsed?.status !== 'ok') continue
      for (const sym of parsed.symbols as Array<{ qualifiedName: string; declaredType?: string }>)
        if (sym.declaredType) declaredTypes.set(sym.qualifiedName, sym.declaredType)
      for (const ref of parsed.references)
        if (ref.kind === 'extends' && ref.from && !ref.from.startsWith('extension '))
          superOf.set(ref.from, ref.targetName)
    }
    const resolve = moduleResolver({ byQualifiedName, declaredTypes, superOf })
    for (const file of files) {
      const parsed = parses.get(file.path)
      const grammar = grammarFor(file.path)
      if (parsed?.status !== 'ok') continue
      defaultExports.set(file.path, parsed.defaultExport)
      for (const ref of parsed.references) {
        const fromId =
          ref.from === '<file>' ? null : (byPathName.get(`${file.path}|${ref.from}`) ?? null)
        let toId: string | null = null
        let external: string | null = null
        // The tier the row lands in: the parser's own, or what the link pass finds.
        let resolution: string = ref.resolution
        if (ref.target.kind === 'unresolved' && ref.resolution === 'external') {
          // A platform type the parser already placed outside the tree (`UIView`,
          // `AppCompatActivity`), named by its package when the file's imports say it.
          external = MODULE_GRAMMARS.has(grammar!)
            ? outsideOf(grammar!, parsed).externalName(ref.target.name)
            : ref.target.name
        } else if (ref.target.kind === 'unresolved' && MODULE_GRAMMARS.has(grammar!)) {
          const typeEdge = ref.kind === 'extends' || ref.kind === 'implements' || ref.kind === 'new'
          const outside = outsideOf(grammar!, parsed)
          const found = resolve(
            ref.target.name,
            ref.targetName.includes('.') ? 'member' : 'bare',
            outside.isPlatform
          )
          if (found === 'platform' && typeEdge && !outside.isPlatform(ref.target.name)) {
            // A superclass, protocol or constructed type no file declares comes from a package
            // the file imports: an external edge, as an import of a package is for Node.
            external = outside.externalName(ref.target.name)
            resolution = 'external'
          } else if (found === 'platform') continue
          else if (found) {
            toId = found.id
            resolution = found.tier
          } else resolution = 'unresolved'
        } else if (ref.target.kind === 'unresolved') {
          resolution = 'unresolved'
        } else if (ref.target.kind === 'symbol') {
          const at = `${file.path}|${ref.target.qualifiedName}`
          toId = byPathName.get(at) ?? null
          if (!toId) resolution = 'unresolved'
          else if (overloaded.has(at)) resolution = 'heuristic'
        } else if (ref.target.viaReturn) {
          // `const app = createApp(); app.listen()`: the member is called on what the imported
          // function returns. Known when the declaring file is in the tree and its
          // parse recorded a return type; a package's return type is nobody's to know here.
          const modulePath = resolveModule(file.path, ref.target.module, paths, aliases)
          const target = modulePath ? files.find((f) => f.path === modulePath) : undefined
          const targetParse = target ? await this.parsedOf(scope, key, target, pool) : null
          const declared =
            ref.target.name === 'default'
              ? targetParse?.status === 'ok'
                ? targetParse.defaultExport
                : null
              : ref.target.name
          const returned =
            targetParse?.status === 'ok' && declared
              ? targetParse.returnTypes?.[declared]
              : undefined
          if (returned && ref.target.member) {
            external = `${returned.module}#${returned.type}.${ref.target.member}`
            resolution = 'external'
          } else resolution = 'unresolved'
        } else {
          const modulePath = resolveModule(file.path, ref.target.module, paths, aliases)
          if (!modulePath) {
            external = `${ref.target.module}#${ref.target.name}${ref.target.member ? `.${ref.target.member}` : ''}`
            resolution = 'external'
          } else {
            if (
              Object.keys(aliases).some(
                (a) => ref.target.kind === 'import' && ref.target.module.startsWith(a.split('*')[0])
              )
            )
              resolution = resolution === 'heuristic' ? 'heuristic' : 'alias'
            if (!defaultExports.has(modulePath)) {
              const target = files.find((f) => f.path === modulePath)
              const targetParse = target ? await this.parsedOf(scope, key, target, pool) : null
              defaultExports.set(
                modulePath,
                targetParse?.status === 'ok' ? targetParse.defaultExport : null
              )
            }
            const base =
              ref.target.name === 'default'
                ? defaultExports.get(modulePath)
                : ref.target.name === '*'
                  ? null
                  : ref.target.name
            const qualified =
              ref.target.name === '*'
                ? ref.target.member
                : base
                  ? ref.target.member
                    ? `${base}.${ref.target.member}`
                    : base
                  : null
            toId = qualified ? (byPathName.get(`${modulePath}|${qualified}`) ?? null) : null
            // The module is in the tree but declares no such name: kept, counted, never absent.
            if (!toId) resolution = 'unresolved'
          }
        }
        rows.push({
          id: randomUUID(),
          workspace_id: workspaceId,
          commit_id: commitId,
          from_symbol_id: fromId,
          to_symbol_id: toId,
          to_external: external,
          kind: ref.kind,
          path: file.path,
          line: ref.line,
          resolution,
          target_name: ref.targetName.slice(0, 512),
        })
      }
    }
    await inScope(scope, async (trx) => {
      for (let i = 0; i < rows.length; i += 500)
        await trx.table('symbol_references').insert(rows.slice(i, i + 500))
    })
    outcome.references = rows.length
  }

  /** A file's parse from the derivation cache, or a fresh one (cached on success). */
  private async parsedOf(
    scope: Scope,
    key: Buffer,
    file: FileRow,
    pool: ParserPool
  ): Promise<ParseResult | null> {
    const parseKey = derivationKey(
      key,
      'parse',
      file.blob_sha,
      'node',
      `${GRAMMAR_VERSION}+${NODE_SYMBOLS_VERSION}`
    )
    const cached = await this.cached<ParseResult>(scope, parseKey)
    if (cached) return cached
    // An import's target that was never derived (ignored, skipped, no content) has nothing to parse.
    if (file.content === null || file.skip_reason || file.mode === MODE_SYMLINK) return null
    const parsed = await pool.parse(
      file.path,
      file.content!,
      this.options.parseTimeoutMs ?? Number(process.env.PARSE_TIMEOUT_MS ?? 5000)
    )
    if (parsed?.status === 'ok') await this.cache(scope, parseKey, 'parse', parsed)
    return parsed ?? null
  }

  private async storeFacts(
    trx: TransactionClientContract,
    workspaceId: string,
    commitId: string,
    files: FileRow[]
  ) {
    const sources: Record<string, string | undefined> = {}
    for (const name of FACT_FILES)
      sources[name] = files.find((f) => f.path === name)?.content ?? undefined
    const facts = await extractRepoFacts(sources)
    await trx
      .table('repo_facts')
      .insert({
        commit_id: commitId,
        workspace_id: workspaceId,
        profile: 'node',
        facts: JSON.stringify(facts),
      })
      .onConflict(['commit_id'])
      .merge({ facts: JSON.stringify(facts) })
  }

  /**
   * Extract step (design §4): endpoints, Tier 0 dependencies and
   * Swift and Kotlin facts come from the child; Tier 1 surfaces are fetched by
   * `name@version` from configured registries and parsed in the child too.
   */
  private async extract(
    scope: Scope,
    workspaceId: string,
    commitId: string,
    files: FileRow[],
    pool: ParserPool,
    outcome: IndexOutcome
  ) {
    const sources: Record<string, string> = {}
    for (const file of files) if (file.content !== null) sources[file.path] = file.content
    const extracted = await pool.extract(sources, EXTRACT_TIMEOUT_MS)
    await inScope(scope, async (trx) => {
      await trx.from('endpoints').where('commit_id', commitId).delete()
      await trx.from('dependencies').where('commit_id', commitId).delete()
      await trx.from('manifests').where('commit_id', commitId).delete()
      for (const manifest of extracted.manifests)
        await trx.table('manifests').insert({
          id: randomUUID(),
          workspace_id: workspaceId,
          commit_id: commitId,
          path: manifest.path,
          ecosystem: manifest.ecosystem,
          status: manifest.status,
          dependencies: manifest.dependencies,
        })
      for (const endpoint of extracted.endpoints)
        await trx
          .table('endpoints')
          .insert({ id: randomUUID(), workspace_id: workspaceId, commit_id: commitId, ...endpoint })
      for (const dependency of extracted.dependencies)
        await trx.table('dependencies').insert({
          id: randomUUID(),
          workspace_id: workspaceId,
          commit_id: commitId,
          ecosystem: dependency.ecosystem,
          name: dependency.name,
          version: dependency.version,
          kind: dependency.kind,
          importers: JSON.stringify(dependency.importers),
          integrity: dependency.integrity,
          resolved: dependency.resolved,
          manifest: dependency.manifest,
          line: dependency.line,
        })
      // A language profile's facts replace the Node defaults; a repository with both Swift and
      // Kotlin (Kotlin Multiplatform) keeps Swift's at the top and Kotlin's under `kotlin`.
      const language = extracted.swiftFacts
        ? {
            profile: 'swift',
            facts: extracted.kotlinFacts
              ? { ...extracted.swiftFacts, kotlin: extracted.kotlinFacts }
              : extracted.swiftFacts,
          }
        : extracted.kotlinFacts
          ? { profile: 'kotlin', facts: extracted.kotlinFacts }
          : null
      if (language)
        await trx
          .table('repo_facts')
          .insert({
            commit_id: commitId,
            workspace_id: workspaceId,
            profile: language.profile,
            facts: JSON.stringify(language.facts),
          })
          .onConflict(['commit_id'])
          .merge({ profile: language.profile, facts: JSON.stringify(language.facts) })
    })
    outcome.endpoints = extracted.endpoints.length
    outcome.dependencies = extracted.dependencies.length
    const config = registryConfig()
    for (const dependency of extracted.dependencies) {
      if (dependency.ecosystem !== 'npm' || !TIER1_KINDS.has(dependency.kind)) continue
      const status = await this.tier1(
        dependency.name,
        dependency.version,
        dependency.integrity,
        pool,
        config
      )
      outcome.tier1[status] = (outcome.tier1[status] ?? 0) + 1
      await inScope(scope, (trx) =>
        trx
          .from('dependencies')
          .where({ commit_id: commitId, ecosystem: 'npm', name: dependency.name })
          .update({ tier1_status: status })
      )
    }
  }

  /**
   * Detect clones step (design §7): tokens come from the child,
   * classes are stored per commit and LSH bands per workspace so similarity
   * queries can span a workspace's active commits under RLS and repository ACL.
   */
  private async detectClones(
    scope: Scope,
    workspaceId: string,
    commitId: string,
    files: FileRow[],
    pool: ParserPool,
    outcome: IndexOutcome
  ) {
    const sources: Record<string, string> = {}
    for (const file of files)
      // Clone detection tokenises through the grammar; JSON has none (WP-19).
      if (
        file.content !== null &&
        grammarFor(file.path) &&
        !SCANNER_GRAMMARS.has(grammarFor(file.path)!)
      )
        sources[file.path] = file.content
    const symbols = await pool.clones(sources, EXTRACT_TIMEOUT_MS)
    const config = cloneConfig()
    const classes = detectClones(symbols, config)
    await inScope(scope, async (trx) => {
      await trx.from('clone_classes').where('commit_id', commitId).delete()
      await trx.from('clone_signatures').where('commit_id', commitId).delete()
      for (const cloneClass of classes) {
        const classId = randomUUID()
        await trx.table('clone_classes').insert({
          id: classId,
          workspace_id: workspaceId,
          commit_id: commitId,
          type: cloneClass.type,
          classification: cloneClass.classification,
          method: cloneClass.method,
          similarity: cloneClass.similarity,
          size: cloneClass.members.length,
        })
        for (const member of cloneClass.members)
          await trx.table('clone_members').insert({
            id: randomUUID(),
            workspace_id: workspaceId,
            class_id: classId,
            path: member.path,
            qualified_name: member.qualifiedName,
            start_line: member.startLine,
            end_line: member.endLine,
            tokens: member.tokens,
            divergence: JSON.stringify(member.divergence),
          })
      }
      for (const { symbol, bands } of signatureBands(symbols, config))
        for (const band of bands)
          await trx.table('clone_signatures').insert({
            id: randomUUID(),
            workspace_id: workspaceId,
            commit_id: commitId,
            path: symbol.path,
            qualified_name: symbol.qualifiedName,
            start_line: symbol.startLine,
            end_line: symbol.endLine,
            band,
          })
    })
    outcome.cloneClasses = classes.length
  }

  /** Fetches and stores one package's API surface unless it is already known (public artefact). */
  async tier1(
    name: string,
    version: string,
    integrity: string | null,
    pool: ParserPool,
    config = registryConfig()
  ): Promise<string> {
    if (config.registries.length === 0) return 'no_registry_configured'
    const known = await db.from('dependency_symbols').where({ package: name, version }).first()
    if (known) return 'cached'
    const fetched = await fetchPackageSurface({ name, version, integrity, resolved: null }, config)
    if (fetched.status !== 'ok') return fetched.reason
    const surface = await pool.surface(Object.fromEntries(fetched.files), EXTRACT_TIMEOUT_MS)
    const fetchedAt = new Date()
    for (const symbol of surface)
      await db
        .table('dependency_symbols')
        .insert({
          id: randomUUID(),
          package: name,
          version,
          ...symbol,
          registry: fetched.registry,
          fetched_at: fetchedAt,
        })
        .onConflict(['package', 'version', 'name', 'path'])
        .ignore()
    return surface.length ? 'ok' : 'no_types'
  }

  /** Copies symbol, block and chunk rows for a file whose blob and path did not change. */
  private async copyFromPrevious(
    scope: Scope,
    key: Buffer,
    previousCommitId: string,
    commitId: string,
    file: FileRow,
    embedder: Embedder,
    outcome: IndexOutcome
  ): Promise<boolean> {
    return inScope(scope, async (trx) => {
      // Only vectors this embedder produced are copied: a chunk's embedding_key is the derivation
      // key of (embedder id, text), so another backend's vectors are recomputed, never mixed
      // into one index (the first run on the model server copied 11,100 CPU vectors).
      const previous = await trx
        .from('chunks')
        .where({ commit_id: previousCommitId, path: file.path, blob_sha: file.blob_sha })
        .select('text', 'embedding_key', 'chunker_version', 'scan_version')
      if (
        previous.some(
          (c) => c.embedding_key !== derivationKey(key, 'embed', embedder.id, String(c.text))
        )
      )
        return false
      // Nor chunks another chunker cut: a version bump must reach unchanged files on
      // the next commit, or an index keeps its old windows and lone blocks for as long as a file
      // goes unedited. Before this the only guard was the embedder's.
      if (previous.some((c) => c.chunker_version !== CHUNKER_VERSION)) return false
      // Nor chunks scanned under another extraction: the flag a reader sees must be the
      // current classifier's, and parse and embeddings are cached, so this costs the scan alone.
      if (previous.some((c) => c.scan_version !== SCAN_VERSION)) return false
      const symbols = await trx
        .from('symbols')
        .where({ commit_id: previousCommitId, path: file.path, blob_sha: file.blob_sha })
      if (symbols.length === 0) return false
      const idMap = new Map<string, string>()
      for (const symbol of symbols) {
        const id = randomUUID()
        idMap.set(symbol.id, id)
        await trx.table('symbols').insert({ ...symbol, id, commit_id: commitId })
        const blocks = await trx.from('citation_blocks').where('symbol_id', symbol.id)
        for (const block of blocks)
          await trx.table('citation_blocks').insert({ ...block, id: randomUUID(), symbol_id: id })
        outcome.symbols++
      }
      const chunks = await trx
        .from('chunks')
        .where({
          workspace_id: scope.workspaceId!,
          commit_id: previousCommitId,
          path: file.path,
          blob_sha: file.blob_sha,
        })
        .select('*', trx.raw('embedding::text as embedding_text'))
      for (const chunk of chunks) {
        const { embedding_text: embeddingText, ...rest } = chunk
        // Generated and vector columns are re-derived on insert.
        delete rest.embedding
        delete rest.search_tsv
        await trx.table('chunks').insert({
          ...rest,
          id: randomUUID(),
          commit_id: commitId,
          symbol_id: idMap.get(chunk.symbol_id) ?? null,
          embedding: embeddingText,
        })
        outcome.chunks++
      }
      return true
    })
  }

  private async deriveFile(
    scope: Scope,
    key: Buffer,
    commitId: string,
    file: FileRow,
    pool: ParserPool,
    embedder: Embedder,
    detector: InjectionDetector,
    outcome: IndexOutcome
  ) {
    const workspaceId = scope.workspaceId!
    const parseKey = derivationKey(
      key,
      'parse',
      file.blob_sha,
      'node',
      `${GRAMMAR_VERSION}+${NODE_SYMBOLS_VERSION}`
    )
    let parsed = await this.cached<ParseResult>(scope, parseKey)
    if (!parsed) {
      // JSON and Markdown have no syntax tree: the linear scanners run in-process, outside the
      // parser child's wall-clock budget, which exists for grammars that can take pathological time.
      parsed = SCANNER_GRAMMARS.has(grammarFor(file.path)!)
        ? await parseSource({ path: file.path, content: file.content!, timeoutMs: 0 })
        : await pool.parse(
            file.path,
            file.content!,
            this.options.parseTimeoutMs ?? Number(process.env.PARSE_TIMEOUT_MS ?? 5000)
          )
      if (parsed.status === 'ok') await this.cache(scope, parseKey, 'parse', parsed)
    }
    if (parsed.status !== 'ok') {
      outcome.filesSkipped[`parse_${parsed.status}`] =
        (outcome.filesSkipped[`parse_${parsed.status}`] ?? 0) + 1
      // Named in the log: a timeout under load leaves a file out of the index (and out of the
      // parse cache), which a later run of the same blob would silently include.
      logger.warn({ path: file.path, status: parsed.status }, 'file not parsed')
      return
    }
    outcome.filesParsed++

    const chunks = chunkSymbols(file.path, file.content!, parsed.symbols)
    const embedded = chunks.map((c) => c.header + c.code)
    const vectors = await this.embedAll(scope, key, embedder, embedded, outcome)

    await inScope(scope, async (trx) => {
      const symbolIds: string[] = []
      for (const symbol of parsed!.symbols) {
        const id = randomUUID()
        symbolIds.push(id)
        await trx.table('symbols').insert({
          id,
          workspace_id: workspaceId,
          commit_id: commitId,
          path: file.path,
          blob_sha: file.blob_sha,
          kind: symbol.kind,
          name: symbolName(symbol.name),
          qualified_name: symbol.qualifiedName,
          parent: symbol.parent,
          start_line: symbol.startLine,
          end_line: symbol.endLine,
          language: parsed!.grammar,
        })
        for (const [ordinal, block] of symbol.blocks.entries()) {
          await trx.table('citation_blocks').insert({
            id: randomUUID(),
            workspace_id: workspaceId,
            symbol_id: id,
            ordinal,
            start_line: block.startLine,
            end_line: block.endLine,
          })
        }
        outcome.symbols++
      }
      // Scored once per workspace, detector and chunk text (design §4 scanKey;); the
      // file's misses go to the detector in one call where it takes several (the model server).
      // The classifier reads a chunk's prose — comments and strings — never its code tokens; a
      // chunk without prose is clean by construction (SCAN_VERSION keys the rule).
      const prose = chunks.map((c) => classifiableText(c.code, file.path))
      const scanKeys = chunks.map((_, i) =>
        derivationKey(key, 'scan', detector.id, SCAN_VERSION, prose[i] ?? '')
      )
      const cachedScans = scanKeys.length
        ? await trx
            .from('derivation_cache')
            .where('workspace_id', workspaceId)
            .whereIn('key', scanKeys)
            .select('key', 'value')
        : []
      // A verdict and, when suspected, which window tripped the detector: a cached verdict
      // from before the window was recorded reads as "unknown", shown as the chunk's whole prose.
      type Scan = { suspected: boolean; window: number | null }
      const scans = new Map<string, Scan>(
        cachedScans.map((row) => {
          const value = row.value as { suspected: boolean; window?: number | null }
          return [String(row.key), { suspected: value.suspected, window: value.window ?? null }]
        })
      )
      for (const [i, text] of prose.entries())
        if (text === null) scans.set(scanKeys[i], { suspected: false, window: null })
      const misses = chunks.map((_, i) => i).filter((i) => !scans.has(scanKeys[i]))
      // Every window of the prose is scanned, not its first 2,000 characters: the
      // classifier reads CLASSIFY_MAX_CHARS of a text, and a chunk of a whole function can carry
      // more prose than that. A chunk is suspected when any of its windows is.
      const windows = misses.map((i) => scanWindows(prose[i]!))
      const flat = windows.flat()
      const verdicts = detector.detectMany
        ? await detector.detectMany(flat)
        : await Promise.all(flat.map((text) => detector.detect(text)))
      let offset = 0
      for (const [j, i] of misses.entries()) {
        const window = verdicts.slice(offset, offset + windows[j].length).findIndex(Boolean)
        offset += windows[j].length
        const scan: Scan = { suspected: window >= 0, window: window >= 0 ? window : null }
        scans.set(scanKeys[i], scan)
        await this.cacheIn(trx, workspaceId, scanKeys[i], 'scan', scan)
      }
      for (const [i, chunk] of chunks.entries()) {
        const symbol = parsed!.symbols[chunk.symbolIndex]
        const { suspected, window } = scans.get(scanKeys[i])!
        if (suspected) {
          outcome.flagged++
          if (outcome.flaggedSpans.length < MAX_FLAGGED_SPANS)
            outcome.flaggedSpans.push({
              path: file.path,
              start: chunk.startLine,
              end: chunk.endLine,
            })
        }
        await trx.table('chunks').insert({
          id: randomUUID(),
          workspace_id: workspaceId,
          commit_id: commitId,
          path: file.path,
          blob_sha: file.blob_sha,
          symbol_id: symbolIds[chunk.symbolIndex],
          start_line: chunk.startLine,
          end_line: chunk.endLine,
          text: chunk.header + chunk.code,
          search_text: buildSearchText({
            path: file.path,
            symbol: symbol.qualifiedName,
            code: chunk.code,
          }),
          embedding: toVectorLiteral(vectors[i]),
          embedding_key: derivationKey(key, 'embed', embedder.id, embedded[i]),
          chunker_version: CHUNKER_VERSION,
          scan_version: SCAN_VERSION,
          injection_suspected: suspected,
          flagged_window: suspected ? window : null,
        })
        outcome.chunks++
      }
    })
  }

  /** Embeddings are cached per workspace under HMAC(workspaceKey, 'embed', embedderId, text). */
  private async embedAll(
    scope: Scope,
    key: Buffer,
    embedder: Embedder,
    texts: string[],
    outcome: IndexOutcome
  ): Promise<Float32Array[]> {
    const keys = texts.map((t) => derivationKey(key, 'embed', embedder.id, t))
    const hits = new Map<string, number[]>()
    const rows = keys.length
      ? await inScope(scope, (trx) =>
          trx
            .from('derivation_cache')
            .where('workspace_id', scope.workspaceId!)
            .whereIn('key', keys)
            .select('key', 'value')
        )
      : []
    for (const row of rows) hits.set(row.key, (row.value as { vector: number[] }).vector)
    const missing = texts.map((_, i) => i).filter((i) => !hits.has(keys[i]))
    const computed = await embedInBatches(
      embedder,
      missing.map((i) => texts[i]),
      embedBatchOptions()
    )
    outcome.embeddingsComputed += missing.length
    outcome.embeddingsCached += texts.length - missing.length
    if (missing.length) {
      await inScope(scope, async (trx) => {
        for (const [j, i] of missing.entries()) {
          await this.cacheIn(trx, scope.workspaceId!, keys[i], 'embedding', {
            vector: Array.from(computed[j]),
          })
        }
      })
    }
    return texts.map((_, i) => {
      const hit = hits.get(keys[i])
      return hit ? Float32Array.from(hit) : computed[missing.indexOf(i)]
    })
  }

  private cached<T>(scope: Scope, key: string): Promise<T | null> {
    return inScope(scope, async (trx) => {
      const row = await trx
        .from('derivation_cache')
        .where({ workspace_id: scope.workspaceId, key })
        .first()
      return (row?.value as T) ?? null
    })
  }

  private cache(scope: Scope, key: string, kind: string, value: unknown) {
    return inScope(scope, (trx) => this.cacheIn(trx, scope.workspaceId!, key, kind, value))
  }

  private async cacheIn(
    trx: TransactionClientContract,
    workspaceId: string,
    key: string,
    kind: string,
    value: unknown
  ) {
    await trx
      .table('derivation_cache')
      .insert({
        workspace_id: workspaceId,
        key,
        kind,
        value: JSON.stringify(value),
        created_at: new Date(),
      })
      .onConflict(['workspace_id', 'key'])
      .ignore()
  }

  /**
   * One honeytoken per workspace (design §4, SEC-30): a plausible-looking
   * snippet holding a unique token. Stored globally so a broken workspace
   * filter surfaces foreign tokens, which the gateway treats as a P1 event.
   */
  private async plantHoneytoken(workspaceId: string, embedder: Embedder) {
    const existing = await db.from('honeytokens').where('workspace_id', workspaceId).first()
    if (existing) return
    const token = `HT-${randomBytes(12).toString('hex')}`
    const text = `// path: config/integrations.ts\n// symbol: partnerApiConfig\nexport const partnerApiConfig = {\n  baseUrl: 'https://partner.example.internal',\n  apiToken: '${token}',\n}\n`
    const [vector] = await embedder.embed([text])
    await db
      .table('honeytokens')
      .insert({
        id: randomUUID(),
        workspace_id: workspaceId,
        token,
        text,
        search_text: buildSearchText({
          path: 'config/integrations.ts',
          symbol: 'partnerApiConfig',
          code: text,
        }),
        embedding: toVectorLiteral(vector),
        created_at: new Date(),
      })
      .onConflict(['workspace_id'])
      .ignore()
    // The gateway recognises foreign tokens by HMAC only; the plaintext never leaves the app (SEC-30).
    await db
      .table('gateway.honeytoken_hmacs')
      .insert({ workspace_id: workspaceId, hmac: honeytokenHmac(token) })
      .onConflict(['workspace_id'])
      .ignore()
  }
}

/** HMAC(HONEYTOKEN_HMAC_KEY, token): the shared secret with the gateway, never the token itself. */
export function honeytokenHmac(token: string): string {
  return createHmac('sha256', process.env.HONEYTOKEN_HMAC_KEY ?? 'local-honeytoken-key')
    .update(token)
    .digest('hex')
}

const MODULE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']
const INDEX_FILES = ['index.ts', 'index.tsx', '.js', 'index.js', 'index.jsx', 'index.mjs']

/**
 * The file a module specifier names at the commit: relative to the importer,
 * with the extensions Node and TypeScript resolve, an ESM `.js` suffix that
 * means a `.ts` source, and a bare specifier tried from the root and `src/`
 * (a bundler alias). Null for a package.
 */
export function resolveModule(
  importer: string,
  specifier: string,
  paths: Set<string>,
  aliases: Record<string, string[]> = {}
): string | null {
  if (specifier.startsWith('node:')) return null
  const candidates: string[] = []
  for (const [pattern, targets] of Object.entries(aliases)) {
    const [prefix, suffix = ''] = pattern.split('*')
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue
    const rest = specifier.slice(prefix.length, specifier.length - suffix.length)
    for (const target of targets) candidates.push(target.replace('*', rest))
  }
  const join = (base: string, rel: string) => {
    const parts = (base ? base.split('/') : []).concat(rel.split('/'))
    const out: string[] = []
    for (const p of parts) {
      if (p === '.' || p === '') continue
      if (p === '..') out.pop()
      else out.push(p)
    }
    return out.join('/')
  }
  const importerDir = importer.includes('/') ? importer.slice(0, importer.lastIndexOf('/')) : ''
  if (specifier.startsWith('.')) candidates.push(join(importerDir, specifier))
  else if (specifier.startsWith('/')) candidates.push(specifier.slice(1))
  else candidates.push(specifier, `src/${specifier}`)
  for (const c of candidates) {
    const stem = c.replace(/\.(js|jsx|mjs|cjs)$/, (m) => m)
    for (const ext of MODULE_EXTENSIONS) if (paths.has(`${stem}${ext}`)) return `${stem}${ext}`
    // `./x.js` in TypeScript sources names `./x.ts`.
    const tsFromJs = c
      .replace(/\.js$/, '.ts')
      .replace(/\.mjs$/, '.mts')
      .replace(/\.jsx$/, '.tsx')
    if (tsFromJs !== c && paths.has(tsFromJs)) return tsFromJs
    for (const index of INDEX_FILES) if (paths.has(`${c}/${index}`)) return `${c}/${index}`
  }
  return null
}
