import type { ParsedSymbol } from '#app/parse/profiles/node_symbols'
import type { SwiftSymbol } from '#app/parse/profiles/swift_symbols'

/**
 * Repo facts for the Swift profile (design §4): tools version, deployment
 * targets, UI framework, `Package.resolved` pins, `Info.plist` keys and
 * entitlements, plus negative facts. Type surfaces are assembled across
 * files so an extension in `Order+Pricing.swift` adds members to `Order`
 * (the expansion rule: a type hit expands to all of its extensions).
 */
export interface SwiftTypeSurface {
  name: string
  kind: 'struct' | 'class' | 'enum' | 'protocol' | 'unknown'
  declaredIn: string | null
  conformances: string[]
  members: string[]
  extensions: Array<{ path: string; members: string[] }>
  /** For protocols: members given a default implementation in an extension. */
  protocolDefaults: string[]
  attributes: string[]
}

export interface SwiftRepoFacts {
  swiftToolsVersion: string | null
  deploymentTargets: Record<string, string>
  ui: { swiftUI: boolean; uiKit: boolean }
  resolvedPackages: Record<string, string>
  infoPlistKeys: string[]
  entitlements: string[]
  types: SwiftTypeSurface[]
  negativeFacts: string[]
}

export interface ParsedSwiftFile {
  path: string
  symbols: ParsedSymbol[]
}

const PLATFORM = /\.(iOS|macOS|watchOS|tvOS|visionOS)\(\s*(?:\.v(\d+)(?:_(\d+))?|"([\d.]+)")\s*\)/g
const IMPORTS = /^\s*import\s+([A-Za-z_]\w*)/gm
const PLIST_KEY = /<key>([^<]+)<\/key>/g

function parseJson(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function extractSwiftFacts(
  files: Record<string, string | undefined>,
  parsed: ParsedSwiftFile[]
): Promise<SwiftRepoFacts> {
  const manifest = files['Package.swift'] ?? ''
  const deploymentTargets: Record<string, string> = {}
  for (const m of manifest.matchAll(PLATFORM))
    deploymentTargets[m[1]] = m[4] ?? (m[3] ? `${m[2]}.${m[3]}` : m[2])

  const imports = new Set<string>()
  const attributes = new Set<string>()
  for (const [path, text] of Object.entries(files))
    if (path.endsWith('.swift') && text) for (const m of text.matchAll(IMPORTS)) imports.add(m[1])
  for (const file of parsed)
    for (const symbol of file.symbols as SwiftSymbol[])
      for (const attribute of symbol.attributes ?? []) attributes.add(attribute)

  const resolved = parseJson(files['Package.resolved'])
  const resolvedPackages: Record<string, string> = {}
  for (const pin of (resolved?.pins as Array<Record<string, any>> | undefined) ?? [])
    if (pin.identity && pin.state?.version) resolvedPackages[pin.identity] = pin.state.version

  const plistPath = Object.keys(files).find((p) => p.endsWith('Info.plist'))
  const entitlementsPath = Object.keys(files).find((p) => p.endsWith('.entitlements'))
  const keysOf = (path?: string) =>
    path ? Array.from((files[path] ?? '').matchAll(PLIST_KEY), (m) => m[1]) : []

  const ui = { swiftUI: imports.has('SwiftUI'), uiKit: imports.has('UIKit') }
  const negativeFacts: string[] = []
  if (!attributes.has('Observable')) negativeFacts.push('no `@Observable` usage')
  if (!imports.has('SwiftData')) negativeFacts.push('no SwiftData')
  if (!ui.swiftUI) negativeFacts.push('no SwiftUI')
  if (!ui.uiKit) negativeFacts.push('no UIKit')
  if (!plistPath) negativeFacts.push('no Info.plist')
  if (!entitlementsPath) negativeFacts.push('no entitlements file')

  return {
    swiftToolsVersion: /swift-tools-version:\s*([\d.]+)/.exec(manifest)?.[1] ?? null,
    deploymentTargets,
    ui,
    resolvedPackages,
    infoPlistKeys: keysOf(plistPath),
    entitlements: keysOf(entitlementsPath),
    types: assembleTypes(parsed),
    negativeFacts,
  }
}

/** Members from every file are attributed to the type they extend, in source order. */
export function assembleTypes(parsed: ParsedSwiftFile[]): SwiftTypeSurface[] {
  const types = new Map<string, SwiftTypeSurface>()
  const surface = (name: string): SwiftTypeSurface => {
    let t = types.get(name)
    if (!t) {
      t = {
        name,
        kind: 'unknown',
        declaredIn: null,
        conformances: [],
        members: [],
        extensions: [],
        protocolDefaults: [],
        attributes: [],
      }
      types.set(name, t)
    }
    return t
  }
  for (const file of parsed) {
    for (const symbol of file.symbols as SwiftSymbol[]) {
      if (['struct', 'class', 'enum', 'protocol'].includes(symbol.kind)) {
        const t = surface(symbol.qualifiedName)
        t.kind = symbol.kind as SwiftTypeSurface['kind']
        t.declaredIn = file.path
        t.conformances.push(...(symbol.conformances ?? []))
        t.attributes.push(...(symbol.attributes ?? []))
      } else if (symbol.kind === 'extension') {
        const t = surface(symbol.name)
        t.conformances.push(...(symbol.conformances ?? []))
        t.extensions.push({ path: file.path, members: [] })
      }
    }
    for (const symbol of file.symbols) {
      if (!symbol.parent || !['method', 'property', 'variable'].includes(symbol.kind)) continue
      const t = surface(symbol.parent)
      if (!t.members.includes(symbol.name)) t.members.push(symbol.name)
      const extension = t.extensions.find((e) => e.path === file.path)
      const declaredHere = t.declaredIn === file.path
      if (extension && !declaredHere) extension.members.push(symbol.name)
      else if (extension && declaredHere && !isDeclaredMember(file, t.name, symbol)) {
        extension.members.push(symbol.name)
      }
    }
  }
  for (const t of types.values()) {
    if (t.kind === 'protocol')
      t.protocolDefaults = t.extensions
        .flatMap((e) => e.members)
        .filter((m, i, a) => a.indexOf(m) === i)
    t.conformances = t.conformances.filter((c, i, a) => a.indexOf(c) === i)
  }
  return Array.from(types.values())
}

/** A member lies within the type declaration's line range (not in a same-file extension). */
function isDeclaredMember(file: ParsedSwiftFile, typeName: string, member: ParsedSymbol): boolean {
  const declaration = file.symbols.find(
    (s) => s.qualifiedName === typeName && s.kind !== 'extension'
  )
  return (
    !!declaration &&
    member.startLine >= declaration.startLine &&
    member.endLine <= declaration.endLine
  )
}
