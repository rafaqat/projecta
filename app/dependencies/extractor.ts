import { withTree } from '#app/parse/parser'
import { readManifests, type Ecosystem, type ManifestRecord } from '#app/dependencies/manifests'

/**
 * Tier 0 dependency facts: name, locked version, direct or
 * transitive, integrity hash, and the files that import each package.
 * Node reads `package.json` and `package-lock.json` (lockfile v2/v3);
 * Swift reads `Package.resolved`. Nothing here fetches anything.
 */
export interface DependencyFact {
  ecosystem: Ecosystem
  name: string
  version: string
  kind: 'direct' | 'dev' | 'transitive'
  integrity: string | null
  resolved: string | null
  importers: string[]
  /** The manifest the row was read from and the line of its declaration; a lockfile row has no line. */
  manifest: string
  line: number | null
}

export interface DependencyExtraction {
  dependencies: DependencyFact[]
  manifests: ManifestRecord[]
}

const PARSE_TIMEOUT_MS = 5000
const SOURCE = /\.(tsx?|jsx?|mjs|cjs)$/

function parseJson(text: string | undefined): Record<string, any> | null {
  if (!text) return null
  try {
    return JSON.parse(text) as Record<string, any>
  } catch {
    return null
  }
}

/** `@scope/pkg/sub` → `@scope/pkg`; `pkg/sub` → `pkg`; relative and alias imports → null. */
export function packageOf(specifier: string): string | null {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('#') ||
    specifier.startsWith('@/')
  )
    return null
  const parts = specifier.replace(/^node:/, 'node:').split('/')
  if (specifier.startsWith('node:')) return null
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

async function importersByPackage(
  files: Record<string, string | undefined>
): Promise<Map<string, Set<string>>> {
  const importers = new Map<string, Set<string>>()
  for (const [path, content] of Object.entries(files)) {
    if (!content || !SOURCE.test(path) || path.includes('node_modules/')) continue
    await withTree({ path, content, timeoutMs: PARSE_TIMEOUT_MS }, (root) => {
      const specifiers = [
        ...root.descendantsOfType('import_statement').map((s) => s!.childForFieldName('source')),
        ...root
          .descendantsOfType('call_expression')
          .filter((c) =>
            ['require', 'import'].includes(c!.childForFieldName('function')?.text ?? '')
          )
          .map((c) => c!.childForFieldName('arguments')?.namedChildren[0] ?? null),
      ]
      for (const node of specifiers) {
        if (node?.type !== 'string') continue
        const pkg = packageOf(node.text.slice(1, -1))
        if (!pkg) continue
        if (!importers.has(pkg)) importers.set(pkg, new Set())
        importers.get(pkg)!.add(path)
      }
    })
  }
  return importers
}

export async function extractDependencies(
  files: Record<string, string | undefined>
): Promise<DependencyFact[]> {
  const out: DependencyFact[] = []
  const importers = await importersByPackage(files)
  const pkg = parseJson(files['package.json'])
  const lock = parseJson(files['package-lock.json'])
  if (pkg || lock) {
    const direct = new Set(Object.keys(pkg?.dependencies ?? {}))
    const dev = new Set(Object.keys(pkg?.devDependencies ?? {}))
    const seen = new Set<string>()
    for (const [path, entry] of Object.entries((lock?.packages ?? {}) as Record<string, any>)) {
      if (!path.startsWith('node_modules/') || !entry?.version) continue
      const name = path.slice(path.lastIndexOf('node_modules/') + 13)
      if (seen.has(name)) continue
      seen.add(name)
      out.push({
        ecosystem: 'npm',
        name,
        version: String(entry.version),
        kind: direct.has(name) ? 'direct' : dev.has(name) ? 'dev' : 'transitive',
        integrity: typeof entry.integrity === 'string' ? entry.integrity : null,
        resolved: typeof entry.resolved === 'string' ? entry.resolved : null,
        importers: Array.from(importers.get(name) ?? []).sort(),
        manifest: 'package-lock.json',
        line: null,
      })
    }
    // Declared but unlocked packages are still facts, at their declared range.
    for (const [name, range] of Object.entries({
      ...(pkg?.dependencies ?? {}),
      ...(pkg?.devDependencies ?? {}),
    }))
      if (!seen.has(name))
        out.push({
          ecosystem: 'npm',
          name,
          version: String(range),
          kind: direct.has(name) ? 'direct' : 'dev',
          integrity: null,
          resolved: null,
          importers: Array.from(importers.get(name) ?? []).sort(),
          manifest: 'package.json',
          line: null,
        })
  }
  const resolved = parseJson(files['Package.resolved'])
  for (const pin of (resolved?.pins ?? resolved?.object?.pins ?? []) as Array<
    Record<string, any>
  >) {
    const name = pin.identity ?? pin.package
    const version = pin.state?.version ?? pin.state?.revision
    if (name && version)
      out.push({
        ecosystem: 'swiftpm',
        name,
        version: String(version),
        kind: 'direct',
        integrity: null,
        resolved: pin.location ?? null,
        importers: [],
        manifest: 'Package.resolved',
        line: null,
      })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Tier 0 over every manifest at the commit. The root lockfiles
 * keep their locked rows; a declaration the root `package.json` makes gives
 * its locked row the manifest line to cite. Every other manifest's rows are
 * added as read, and the manifests table says which files were read and
 * which the index recognised and did not.
 */
export async function extractAllDependencies(
  files: Record<string, string | undefined>
): Promise<DependencyExtraction> {
  const locked = await extractDependencies(files)
  const read = await readManifests(files)
  const importers = await importersByPackage(files)
  const dependencies: DependencyFact[] = []
  const lockedByName = new Map(locked.map((d) => [`${d.ecosystem}:${d.name}`, d]))
  for (const row of read.dependencies) {
    const known = lockedByName.get(`${row.ecosystem}:${row.name}`)
    if (known && row.manifest === 'package.json') {
      // The root manifest's declaration: the locked row is the fact, at the declared line.
      known.manifest = row.manifest
      known.line = row.line
      continue
    }
    dependencies.push({
      ...row,
      integrity: null,
      resolved: null,
      importers: row.ecosystem === 'npm' ? Array.from(importers.get(row.name) ?? []).sort() : [],
    })
  }
  const lockedRows = locked
  const manifests = read.manifests.filter(
    (m) =>
      !(m.status === 'unread' && (m.path === 'package-lock.json' || m.path === 'Package.resolved'))
  )
  for (const lock of ['package-lock.json', 'Package.resolved'] as const)
    if (files[lock] !== undefined)
      manifests.push({
        path: lock,
        ecosystem: lock === 'package-lock.json' ? 'npm' : 'swiftpm',
        status: 'read',
        dependencies: locked.filter((d) => d.manifest === lock).length,
      })
  manifests.sort((a, b) => a.path.localeCompare(b.path))
  return { dependencies: [...lockedRows, ...dependencies], manifests }
}
