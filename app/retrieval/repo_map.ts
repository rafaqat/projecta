import { inScope, type Scope } from '#app/security/scope'

/**
 * The map of a repository at a commit, from the index alone: what "how is
 * it organised", "what does it do", "where does it start" are answered
 * from (UAT 2026-09-16: the model exhausted its budget searching for a
 * shape no chunk states). Directories with what they hold; entry points by
 * manifest and by name; the symbols the commit references most;
 * the modules it imports most; endpoints, manifests, the README's
 * sections. Every figure is a count over tables; nothing is inferred.
 */
export interface MapDirectory {
  path: string
  files: number
  symbols: number
  languages: Record<string, number>
}

export interface RepoMap {
  files: number
  /** Files the index holds chunks for. */
  indexed: number
  /** The files it holds no chunks for, by extension, most first: what an answer cannot cover. */
  unindexed: Array<{ ext: string; files: number }>
  /** Whether the commit was indexed with references at all; no hubs is not the same as not indexed. */
  referencesIndexed: boolean
  languages: Record<string, number>
  directories: MapDirectory[]
  entryPoints: Array<{ path: string; why: string }>
  hubs: Array<{ qualifiedName: string; path: string; references: number }>
  mostImported: Array<{ module: string; importers: number }>
  endpoints: number
  manifests: Array<{ path: string; status: string }>
  tests: { files: number }
  readme: { path: string; sections: string[] } | null
  /** Chunks to cite: the README's first sections and the entry points' first chunks. */
  chunkIds: string[]
}

const ENTRY_NAMES = /^(index|main|app|server|cli|bin)\.(m?[jt]sx?|cjs)$/i
const TEST_PATH =
  /(^|\/)(tests?|__tests__|spec|specs|.*Tests|androidTest)\/|\.(test|spec)\.[jt]sx?$|Tests\.swift$|Test\.kt$/
const MAX_DIRECTORIES = 14

export async function repoMap(scope: Scope, commitId: string): Promise<RepoMap> {
  return inScope(scope, async (trx) => {
    const files = (await trx
      .from('files')
      .where('commit_id', commitId)
      .whereNull('ignored_by')
      .select('path')) as Array<{ path: string }>
    const symbolsByPath = new Map<string, number>()
    for (const row of (await trx
      .from('symbols')
      .where('commit_id', commitId)
      .whereNotIn('kind', ['region', 'import'])
      .groupBy('path')
      .count('* as n')
      .select('path')) as Array<{ path: string; n: string }>)
      symbolsByPath.set(row.path, Number(row.n))
    const chunkedPaths = new Set(
      (
        (await trx.from('chunks').where('commit_id', commitId).distinct('path')) as Array<{
          path: string
        }>
      ).map((r) => r.path)
    )

    // Directories: the first path segment, and the second where the first is a plain container.
    const languages: Record<string, number> = {}
    const dirs = new Map<string, MapDirectory>()
    const ext = (p: string) =>
      p.includes('.') ? p.slice(p.lastIndexOf('.') + 1).toLowerCase() : ''
    for (const { path } of files) {
      const e = ext(path)
      if (e) languages[e] = (languages[e] ?? 0) + 1
      const parts = path.split('/')
      const dir =
        parts.length <= 2 ? parts.slice(0, -1).join('/') || '.' : parts.slice(0, 2).join('/')
      const d = dirs.get(dir) ?? { path: dir, files: 0, symbols: 0, languages: {} }
      d.files++
      d.symbols += symbolsByPath.get(path) ?? 0
      if (e) d.languages[e] = (d.languages[e] ?? 0) + 1
      dirs.set(dir, d)
    }
    const directories = [...dirs.values()]
      .sort((x, y) => y.symbols - x.symbols || y.files - x.files || x.path.localeCompare(y.path))
      .slice(0, MAX_DIRECTORIES)

    // Entry points: the manifest's start/main/bin, then files named for it.
    const entryPoints: Array<{ path: string; why: string }> = []
    const paths = new Set(files.map((f) => f.path))
    const manifest = await trx
      .from('files')
      .join('blobs', 'blobs.blob_sha', 'files.blob_sha')
      .where({ 'files.commit_id': commitId, 'files.path': 'package.json' })
      .select('blobs.content')
      .first()
    if (manifest?.content) {
      try {
        const pkg = JSON.parse(String(manifest.content)) as {
          main?: string
          bin?: string | Record<string, string>
          scripts?: Record<string, string>
        }
        const named: Array<[string, string]> = []
        if (typeof pkg.main === 'string') named.push([pkg.main, 'package.json main'])
        if (typeof pkg.bin === 'string') named.push([pkg.bin, 'package.json bin'])
        if (pkg.bin && typeof pkg.bin === 'object')
          for (const b of Object.values(pkg.bin)) named.push([b, 'package.json bin'])
        const start = pkg.scripts?.start
        const script = start?.match(
          /(?:node|tsx|ts-node)\s+(?:--[\w-]+\s+)*([\w./-]+\.(?:[mc]?[jt]s))/
        )
        if (script) named.push([script[1], 'package.json start script'])
        for (const [target, why] of named) {
          const candidate = sourceFor(target, paths)
          if (candidate && !entryPoints.some((e) => e.path === candidate))
            entryPoints.push({ path: candidate, why })
        }
      } catch {
        // Not JSON: the manifest reader reports it; the map simply has no manifest entry point.
      }
    }
    // Android: the application class and the launcher activity AndroidManifest.xml names
    // (`.activities.MainActivity` → the .kt file whose path ends in that class path).
    const androidManifests = (await trx
      .from('files')
      .join('blobs', 'blobs.blob_sha', 'files.blob_sha')
      .where('files.commit_id', commitId)
      .whereLike('files.path', '%AndroidManifest.xml')
      .whereNull('files.ignored_by')
      .orderBy('files.path')
      .select('files.path', 'blobs.content')) as Array<{ path: string; content: string | null }>
    for (const android of androidManifests) {
      const xml = String(android.content ?? '')
      const named: Array<[string, string]> = []
      const application = xml.match(/<application\b[^>]*\bandroid:name="([^"]+)"/)
      if (application) named.push([application[1], 'AndroidManifest.xml application'])
      for (const activity of xml.matchAll(/<activity\b([^>]*)>([\s\S]*?)<\/activity>/g)) {
        const name = activity[1].match(/\bandroid:name="([^"]+)"/)?.[1]
        if (name && /android\.intent\.category\.LAUNCHER/.test(activity[2]))
          named.push([name, 'AndroidManifest.xml launcher activity'])
      }
      for (const [className, why] of named) {
        const suffix = `/${className.replace(/^\./, '').replace(/\./g, '/')}.kt`
        const candidate = files.find((f) => f.path.endsWith(suffix))?.path
        if (candidate && !entryPoints.some((e) => e.path === candidate))
          entryPoints.push({ path: candidate, why })
      }
    }
    for (const { path } of files) {
      const base = path.slice(path.lastIndexOf('/') + 1)
      const depth = path.split('/').length
      if (
        (ENTRY_NAMES.test(base) && depth <= 2) ||
        /^AppDelegate\.swift$|^main\.swift$|^App\.swift$/.test(base)
      ) {
        if (!entryPoints.some((e) => e.path === path))
          entryPoints.push({ path, why: `named ${base}` })
      }
    }
    entryPoints.sort((x, y) => x.path.localeCompare(y.path))

    const hubs = (await trx
      .from('symbol_references as r')
      .join('symbols as s', 's.id', 'r.to_symbol_id')
      .where('r.commit_id', commitId)
      .whereNotIn('s.kind', ['region', 'import'])
      // Calls and constructions, not reads: a router read on every route line is not a hub.
      .whereIn('r.kind', ['call', 'new'])
      .groupBy(['s.qualified_name', 's.path'])
      .orderByRaw('count(*) desc, s.qualified_name asc')
      .limit(6)
      .select('s.qualified_name', 's.path')
      .count('* as n')) as Array<{ qualified_name: string; path: string; n: string }>
    const imports = (await trx
      .from('symbols')
      .where({ commit_id: commitId, kind: 'import' })
      .whereNotNull('parent')
      .groupBy('parent')
      .orderByRaw('count(distinct path) desc, parent asc')
      .limit(8)
      .select('parent')
      .countDistinct('path as n')) as Array<{ parent: string; n: string }>
    const endpoints = await trx
      .from('endpoints')
      .where('commit_id', commitId)
      .count('* as n')
      .first()
    const manifests = (await trx
      .from('manifests')
      .where('commit_id', commitId)
      .orderBy('path')
      .select('path', 'status')) as Array<{ path: string; status: string }>

    const readmePath =
      files.map((f) => f.path).find((p) => /^readme(\.(md|markdown|txt))?$/i.test(p)) ?? null
    let readme: RepoMap['readme'] = null
    const chunkIds: string[] = []
    if (readmePath) {
      const sections = (await trx
        .from('symbols')
        .where({ commit_id: commitId, path: readmePath, kind: 'region' })
        .orderBy('start_line')
        .select('qualified_name')) as Array<{ qualified_name: string }>
      readme = {
        path: readmePath,
        sections: sections.map((s) => s.qualified_name).filter((n) => n !== '<file>#1'),
      }
      const first = (await trx
        .from('chunks')
        .where({ commit_id: commitId, path: readmePath })
        .orderBy('start_line')
        .limit(3)
        .select('id')) as Array<{ id: string }>
      chunkIds.push(...first.map((c) => c.id))
    }
    for (const entry of entryPoints.slice(0, 4)) {
      const first = await trx
        .from('chunks')
        .where({ commit_id: commitId, path: entry.path })
        .orderBy('start_line')
        .select('id')
        .first()
      if (first) chunkIds.push(String(first.id))
    }

    const unindexed = new Map<string, number>()
    for (const { path } of files) {
      if (chunkedPaths.has(path)) continue
      const base = path.slice(path.lastIndexOf('/') + 1)
      const e = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '(none)'
      unindexed.set(e, (unindexed.get(e) ?? 0) + 1)
    }
    const referenced = await trx
      .from('symbol_references')
      .where('commit_id', commitId)
      .select('id')
      .first()

    return {
      files: files.length,
      indexed: files.filter((f) => chunkedPaths.has(f.path)).length,
      unindexed: [...unindexed]
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
        .map(([e, n]) => ({ ext: e, files: n })),
      referencesIndexed: Boolean(referenced),
      languages,
      directories,
      entryPoints,
      hubs: hubs.map((h) => ({
        qualifiedName: h.qualified_name,
        path: h.path,
        references: Number(h.n),
      })),
      mostImported: imports
        .filter((i) => !i.parent.startsWith('.') && !i.parent.startsWith('/'))
        .map((i) => ({ module: i.parent, importers: Number(i.n) })),
      endpoints: Number(endpoints?.n ?? 0),
      manifests,
      tests: { files: files.filter((f) => TEST_PATH.test(f.path)).length },
      readme,
      chunkIds,
    }
  })
}

/** `dist/server.js` names `src/server.ts` when the built path is not in the tree. */
function sourceFor(target: string, paths: Set<string>): string | null {
  const clean = target.replace(/^\.\//, '')
  if (paths.has(clean)) return clean
  const stem = clean.replace(/^(dist|build|out|lib)\//, '').replace(/\.(m?[jc]s)$/, '')
  for (const prefix of ['', 'src/', 'lib/', 'app/'])
    for (const ext of ['.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx'])
      if (paths.has(`${prefix}${stem}${ext}`)) return `${prefix}${stem}${ext}`
  return null
}
