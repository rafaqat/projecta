import { withTree } from '#app/parse/parser'
import {
  catalogAccessor,
  isGradleCatalog,
  readGradleCatalog,
} from '#app/dependencies/gradle_catalog'

/**
 * Dependencies from every manifest at the commit: each declaration
 * is a row naming the manifest path and line it sits on, so the table is
 * citable; each manifest is a row saying it was read, or that the index
 * recognised it and could not read it. Line rules where no grammar is
 * shipped; nothing here fetches anything.
 */
export type Ecosystem =
  'npm' | 'swiftpm' | 'gradle' | 'maven' | 'pypi' | 'go' | 'cargo' | 'rubygems'

export type DependencyKind = 'direct' | 'dev' | 'transitive'

export interface ManifestDependency {
  ecosystem: Ecosystem
  name: string
  /** The declared version or range; the literal text when a rule cannot resolve it (a catalog reference). */
  version: string
  kind: DependencyKind
  manifest: string
  line: number
}

export interface ManifestRecord {
  path: string
  /** A read manifest's ecosystem, or the ecosystem of one the index recognises and does not read. */
  ecosystem: Ecosystem | 'cocoapods' | 'composer' | 'pub' | 'hex' | 'sbt' | 'nuget'
  status: 'read' | 'unread'
  dependencies: number
}

export interface ManifestReading {
  dependencies: ManifestDependency[]
  manifests: ManifestRecord[]
}

type Reader = (path: string, text: string) => ManifestDependency[] | Promise<ManifestDependency[]>

const basenameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/* ---------- gradle ---------- */

const GRADLE_DEV = new Set(['testImplementation', 'androidTestImplementation', 'testCompile'])
const GRADLE_CONFIGURATIONS =
  'implementation|api|compileOnly|runtimeOnly|testImplementation|androidTestImplementation|kapt|ksp|annotationProcessor|compile|testCompile|classpath|debugImplementation|releaseImplementation'
/** `implementation 'g:a:v'`, `api("g:a:v")`, `implementation libs.foo`, `implementation(libs.foo)`. */
const GRADLE_STRING = new RegExp(
  `^\\s*(${GRADLE_CONFIGURATIONS})\\s*\\(?\\s*(?:['"]([^'"]+)['"]|(libs\\.[\\w.]+))`
)
/** `implementation group: 'g', name: 'a', version: 'v'` in any order. */
const GRADLE_MAP = new RegExp(`^\\s*(${GRADLE_CONFIGURATIONS})\\s*\\(?\\s*group\\s*[:=]`)
const GRADLE_FIELD = (field: string) => new RegExp(`${field}\\s*[:=]\\s*['"]([^'"]+)['"]`)

const readGradle: Reader = (path, text) => {
  const out: ManifestDependency[] = []
  text.split('\n').forEach((raw, i) => {
    const line = i + 1
    const map = raw.match(GRADLE_MAP)
    if (map) {
      const group = raw.match(GRADLE_FIELD('group'))?.[1]
      const name = raw.match(GRADLE_FIELD('name'))?.[1]
      if (!group || !name) return
      const version = raw.match(GRADLE_FIELD('version'))?.[1] ?? ''
      out.push({
        ecosystem: 'gradle',
        name: `${group}:${name}`,
        version,
        kind: GRADLE_DEV.has(map[1]) ? 'dev' : 'direct',
        manifest: path,
        line,
      })
      return
    }
    const m = raw.match(GRADLE_STRING)
    if (!m) return
    const kind: DependencyKind = GRADLE_DEV.has(m[1]) ? 'dev' : 'direct'
    if (m[3]) {
      // A version-catalog reference: the literal is the fact; the catalog is not resolved.
      out.push({ ecosystem: 'gradle', name: m[3], version: m[3], kind, manifest: path, line })
      return
    }
    const parts = m[2].split(':')
    if (parts.length < 2) return
    out.push({
      ecosystem: 'gradle',
      name: `${parts[0]}:${parts[1]}`,
      version: parts[2] ?? '',
      kind,
      manifest: path,
      line,
    })
  })
  return out
}

/* ---------- npm ---------- */

const NPM_SECTIONS: Record<string, DependencyKind> = {
  dependencies: 'direct',
  peerDependencies: 'direct',
  optionalDependencies: 'direct',
  devDependencies: 'dev',
}
const NPM_SECTION =
  /^\s*"(dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:\s*\{/
const NPM_ENTRY = /^\s*"([^"]+)"\s*:\s*"([^"]*)"/

/** The declared ranges, by line; a lockfile beside the manifest is the extractor's (root) concern. */
const readPackageJson: Reader = (path, text) => {
  const out: ManifestDependency[] = []
  let section: DependencyKind | null = null
  text.split('\n').forEach((raw, i) => {
    const head = raw.match(NPM_SECTION)
    if (head) {
      section = NPM_SECTIONS[head[1]]
      return
    }
    if (section === null) return
    if (/^\s*\}/.test(raw)) {
      section = null
      return
    }
    const entry = raw.match(NPM_ENTRY)
    if (entry)
      out.push({
        ecosystem: 'npm',
        name: entry[1],
        version: entry[2],
        kind: section,
        manifest: path,
        line: i + 1,
      })
  })
  return out
}

/* ---------- maven ---------- */

const POM_TAG = (tag: string) => new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`)

/** One row per `<dependency>` block, at the block's opening line; `${property}` versions stay literal. */
const readPom: Reader = (path, text) => {
  const out: ManifestDependency[] = []
  const lines = text.split('\n')
  let open: number | null = null
  let block: string[] = []
  lines.forEach((raw, i) => {
    if (/<dependency>/.test(raw)) {
      open = i + 1
      block = []
    }
    if (open !== null) block.push(raw)
    if (open !== null && /<\/dependency>/.test(raw)) {
      const body = block.join('\n')
      const group = body.match(POM_TAG('groupId'))?.[1]
      const artifact = body.match(POM_TAG('artifactId'))?.[1]
      if (group && artifact) {
        const scope = body.match(POM_TAG('scope'))?.[1]
        out.push({
          ecosystem: 'maven',
          name: `${group}:${artifact}`,
          version: body.match(POM_TAG('version'))?.[1] ?? '',
          kind: scope === 'test' ? 'dev' : 'direct',
          manifest: path,
          line: open,
        })
      }
      open = null
    }
  })
  return out
}

/* ---------- pypi ---------- */

const REQUIREMENT = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*([<>=!~][^;#\s]*)?/

const readRequirements: Reader = (path, text) => {
  const out: ManifestDependency[] = []
  text.split('\n').forEach((raw, i) => {
    if (/^\s*(#|-|$)/.test(raw)) return
    const m = raw.match(REQUIREMENT)
    if (!m) return
    out.push({
      ecosystem: 'pypi',
      name: m[1],
      version: m[2] ?? '',
      kind: 'direct',
      manifest: path,
      line: i + 1,
    })
  })
  return out
}

/** `[project] dependencies = [...]` and `[project.optional-dependencies]` groups (dev). */
const readPyproject: Reader = (path, text) => {
  const out: ManifestDependency[] = []
  let table = ''
  let inList = false
  let kind: DependencyKind = 'direct'
  const spec = (s: string, line: number) => {
    const m = s.match(REQUIREMENT)
    if (m)
      out.push({ ecosystem: 'pypi', name: m[1], version: m[2] ?? '', kind, manifest: path, line })
  }
  text.split('\n').forEach((raw, i) => {
    const header = raw.match(/^\s*\[([^\]]+)\]/)
    if (header) {
      table = header[1]
      inList = false
      return
    }
    if (table === 'project' && /^\s*dependencies\s*=\s*\[/.test(raw)) {
      kind = 'direct'
      inList = !raw.includes(']')
      for (const q of raw.matchAll(/"([^"]+)"/g)) spec(q[1], i + 1)
      return
    }
    if (table === 'project.optional-dependencies' && /^\s*[\w-]+\s*=\s*\[/.test(raw)) {
      kind = 'dev'
      inList = !raw.includes(']')
      for (const q of raw.matchAll(/"([^"]+)"/g)) spec(q[1], i + 1)
      return
    }
    if (inList) {
      for (const q of raw.matchAll(/"([^"]+)"/g)) spec(q[1], i + 1)
      if (raw.includes(']')) inList = false
    }
  })
  return out
}

/* ---------- go ---------- */

const GO_REQUIRE = /^\s*(?:require\s+)?([\w.\-/~]+\.[\w.\-/~]+)\s+(v[\w.\-+]+)(\s*\/\/\s*indirect)?/

const readGoMod: Reader = (path, text) => {
  const out: ManifestDependency[] = []
  let block = false
  text.split('\n').forEach((raw, i) => {
    if (/^\s*require\s*\(/.test(raw)) {
      block = true
      return
    }
    if (block && /^\s*\)/.test(raw)) {
      block = false
      return
    }
    if (!block && !/^\s*require\s/.test(raw)) return
    const m = raw.match(GO_REQUIRE)
    if (!m) return
    out.push({
      ecosystem: 'go',
      name: m[1],
      version: m[2],
      kind: m[3] ? 'transitive' : 'direct',
      manifest: path,
      line: i + 1,
    })
  })
  return out
}

/* ---------- cargo ---------- */

const readCargo: Reader = (path, text) => {
  const out: ManifestDependency[] = []
  let kind: DependencyKind | null = null
  text.split('\n').forEach((raw, i) => {
    const header = raw.match(/^\s*\[([^\]]+)\]/)
    if (header) {
      const t = header[1]
      kind = /(^|\.)dev-dependencies$/.test(t)
        ? 'dev'
        : /(^|\.)(build-)?dependencies$/.test(t)
          ? 'direct'
          : null
      return
    }
    if (kind === null) return
    const m = raw.match(/^\s*([\w-]+)\s*=\s*(?:"([^"]*)"|\{[^}]*version\s*=\s*"([^"]*)")/)
    if (!m) return
    out.push({
      ecosystem: 'cargo',
      name: m[1],
      version: m[2] ?? m[3] ?? '',
      kind,
      manifest: path,
      line: i + 1,
    })
  })
  return out
}

/* ---------- rubygems ---------- */

const readGemfile: Reader = (path, text) => {
  const out: ManifestDependency[] = []
  let depth = 0
  let devDepth = 0
  text.split('\n').forEach((raw, i) => {
    const group = raw.match(/^\s*group\s+(.+?)\s+do\b/)
    if (group) {
      depth++
      if (/:(test|development)\b/.test(group[1])) devDepth = depth
      return
    }
    if (/^\s*end\b/.test(raw)) {
      if (devDepth === depth) devDepth = 0
      if (depth > 0) depth--
      return
    }
    const m = raw.match(/^\s*gem\s+['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]+)['"])?/)
    if (!m) return
    out.push({
      ecosystem: 'rubygems',
      name: m[1],
      version: m[2] ?? '',
      kind: devDepth > 0 ? 'dev' : 'direct',
      manifest: path,
      line: i + 1,
    })
  })
  return out
}

/* ---------- swiftpm ---------- */

const SWIFT_URL = /url:\s*"([^"]+)"/
const SWIFT_REQUIREMENT =
  /\b(from|exact|branch|revision):\s*"([^"]+)"|"([^"]+)"\s*\.\.[.<]\s*"([^"]+)"/

/** `.package(url:…)` calls from the syntax tree: the row sits on the call's line even when its arguments wrap. */
const readPackageSwift: Reader = async (path, text) => {
  const rows = await withTree({ path, content: text, timeoutMs: 5000 }, (root) => {
    const out: ManifestDependency[] = []
    for (const call of root.descendantsOfType('call_expression')) {
      const callee = call!.namedChildren[0]?.text ?? ''
      if (!/(^|\.)package$/.test(callee)) continue
      const body = call!.text
      const url = body.match(SWIFT_URL)?.[1]
      if (!url) continue
      const name = url
        .replace(/\/+$/, '')
        .split('/')
        .pop()!
        .replace(/\.git$/, '')
      const r = body.match(SWIFT_REQUIREMENT)
      const version = r ? (r[1] ? `${r[1]}: ${r[2]}` : `${r[3]}..<${r[4]}`) : ''
      out.push({
        ecosystem: 'swiftpm',
        name,
        version,
        kind: 'direct',
        manifest: path,
        line: call!.startPosition.row + 1,
      })
    }
    return out
  })
  return rows ?? []
}

/* ---------- registry ---------- */

const READERS: Array<{ match: (basename: string) => boolean; ecosystem: Ecosystem; read: Reader }> =
  [
    { match: (b) => b === 'package.json', ecosystem: 'npm', read: readPackageJson },
    {
      match: (b) => b === 'build.gradle' || b === 'build.gradle.kts',
      ecosystem: 'gradle',
      read: readGradle,
    },
    { match: (b) => b === 'pom.xml', ecosystem: 'maven', read: readPom },
    {
      match: (b) => /^requirements[\w.-]*\.txt$/.test(b),
      ecosystem: 'pypi',
      read: readRequirements,
    },
    { match: (b) => b === 'pyproject.toml', ecosystem: 'pypi', read: readPyproject },
    { match: (b) => b === 'go.mod', ecosystem: 'go', read: readGoMod },
    { match: (b) => b === 'Cargo.toml', ecosystem: 'cargo', read: readCargo },
    { match: (b) => b === 'Gemfile', ecosystem: 'rubygems', read: readGemfile },
    { match: (b) => b === 'Package.swift', ecosystem: 'swiftpm', read: readPackageSwift },
  ]

/**
 * Manifests the index recognises and does not read here: lockfiles (the
 * extractor reads the root npm and SwiftPM locks; others are not read) and
 * ecosystems without a reader. Named so an answer can say so.
 */
const RECOGNISED: Array<{
  match: (basename: string) => boolean
  ecosystem: ManifestRecord['ecosystem']
}> = [
  {
    match: (b) => b === 'package-lock.json' || b === 'yarn.lock' || b === 'pnpm-lock.yaml',
    ecosystem: 'npm',
  },
  { match: (b) => b === 'Package.resolved', ecosystem: 'swiftpm' },
  { match: (b) => b === 'Podfile' || b === 'Podfile.lock', ecosystem: 'cocoapods' },
  { match: (b) => b === 'composer.json' || b === 'composer.lock', ecosystem: 'composer' },
  { match: (b) => b === 'pubspec.yaml' || b === 'pubspec.lock', ecosystem: 'pub' },
  { match: (b) => b === 'mix.exs' || b === 'mix.lock', ecosystem: 'hex' },
  { match: (b) => b === 'build.sbt', ecosystem: 'sbt' },
  { match: (b) => b.endsWith('.csproj') || b === 'packages.config', ecosystem: 'nuget' },
  { match: (b) => b === 'Gemfile.lock', ecosystem: 'rubygems' },
  {
    match: (b) => b === 'poetry.lock' || b === 'Pipfile' || b === 'Pipfile.lock',
    ecosystem: 'pypi',
  },
  { match: (b) => b === 'Cargo.lock', ecosystem: 'cargo' },
  { match: (b) => b === 'go.sum', ecosystem: 'go' },
]

export async function readManifests(
  files: Record<string, string | undefined>
): Promise<ManifestReading> {
  const dependencies: ManifestDependency[] = []
  const manifests: ManifestRecord[] = []
  // Version catalogs: read first, so a build script's `libs.foo` resolves to coordinates.
  const accessors = new Map<string, string>()
  for (const path of Object.keys(files).sort()) {
    const text = files[path]
    if (text === undefined || !isGradleCatalog(path)) continue
    const catalog = readGradleCatalog(text)
    const prefix = basenameOf(path).replace(/\.versions\.toml$/, '')
    for (const [alias, coordinates] of Object.entries(catalog.libraries))
      accessors.set(catalogAccessor(alias, prefix), coordinates)
    manifests.push({ path, ecosystem: 'gradle', status: 'read', dependencies: 0 })
  }
  for (const path of Object.keys(files).sort()) {
    const text = files[path]
    if (text === undefined || isGradleCatalog(path)) continue
    const basename = basenameOf(path)
    const reader = READERS.find((r) => r.match(basename))
    if (!reader) {
      const known = RECOGNISED.find((r) => r.match(basename))
      if (known)
        manifests.push({ path, ecosystem: known.ecosystem, status: 'unread', dependencies: 0 })
      continue
    }
    const rows = await reader.read(path, text)
    for (const row of rows) {
      // `libs.material` → `com.google.android.material:material` at the catalog's version.
      const coordinates = row.ecosystem === 'gradle' ? accessors.get(row.name) : undefined
      if (!coordinates) continue
      const [group, artifact, version] = coordinates.split(':')
      row.name = `${group}:${artifact}`
      row.version = version ?? ''
    }
    dependencies.push(...rows)
    manifests.push({ path, ecosystem: reader.ecosystem, status: 'read', dependencies: rows.length })
  }
  return { dependencies, manifests }
}
