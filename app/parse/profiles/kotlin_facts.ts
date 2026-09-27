import type { ParsedSymbol } from '#app/parse/profiles/node_symbols'
import type { KotlinSymbol } from '#app/parse/profiles/kotlin_symbols'
import { readGradleCatalog } from '#app/dependencies/gradle_catalog'

/**
 * Repo facts for the Kotlin profile (design §4), the counterpart of
 * the Swift facts: the Android build settings, what `AndroidManifest.xml`
 * declares, the UI toolkit, the Jetpack libraries in use, the version
 * catalog resolved to coordinates, plus negative facts. Type surfaces are
 * assembled across files so an extension function in `Dates.kt` adds a
 * member to `Event`.
 */
export interface KotlinTypeSurface {
  name: string
  kind: 'class' | 'interface' | 'enum' | 'unknown'
  declaredIn: string | null
  supertypes: string[]
  annotations: string[]
  members: string[]
  extensions: Array<{ path: string; members: string[] }>
}

export interface KotlinRepoFacts {
  kotlinPluginVersion: string | null
  androidGradlePluginVersion: string | null
  android: {
    namespace: string | null
    applicationId: string | null
    compileSdk: string | null
    minSdk: string | null
    targetSdk: string | null
  }
  manifest: {
    path: string
    application: string | null
    launcher: string | null
    activities: string[]
    services: string[]
    receivers: string[]
    permissions: string[]
  } | null
  ui: { compose: boolean; views: boolean }
  libraries: {
    room: boolean
    coroutines: boolean
    hilt: boolean
    workManager: boolean
    navigation: boolean
    dataStore: boolean
    retrofit: boolean
  }
  catalog: {
    path: string
    versions: Record<string, string>
    libraries: Record<string, string>
  } | null
  types: KotlinTypeSurface[]
  negativeFacts: string[]
}

export interface ParsedKotlinFile {
  path: string
  symbols: ParsedSymbol[]
}

const IMPORT = /^\s*import\s+([\w.]+)/gm
const GRADLE_SCRIPT = /(^|\/)build\.gradle(\.kts)?$/
/** `compileSdk = 34`, `minSdkVersion 26`, `namespace "a.b"`: a setting's first literal. */
const setting = (text: string, names: string[]): string | null => {
  for (const name of names) {
    const m = new RegExp(`\\b${name}\\s*(?:=|\\s)\\s*["']?([\\w.\\-]+)["']?`).exec(text)
    if (m) return m[1]
  }
  return null
}
/** `id("org.jetbrains.kotlin.android") version "2.0.0"` or `kotlin("android") version "2.0.0"`. */
const pluginVersion = (text: string, ids: RegExp): string | null => {
  for (const m of text.matchAll(
    /(?:id|kotlin)\s*\(?\s*["']([\w.\-]+)["']\s*\)?\s+version\s+["']([\w.\-]+)["']/g
  ))
    if (ids.test(m[1])) return m[2]
  return null
}
const attribute = (element: string, name: string) =>
  new RegExp(`\\bandroid:${name}="([^"]+)"`).exec(element)?.[1] ?? null

export async function extractKotlinFacts(
  files: Record<string, string | undefined>,
  parsed: ParsedKotlinFile[]
): Promise<KotlinRepoFacts> {
  const scripts = Object.entries(files)
    .filter(([path, text]) => GRADLE_SCRIPT.test(path) && text)
    .sort(([a], [b]) => a.split('/').length - b.split('/').length || a.localeCompare(b))
  // The application module's script declares `android { … }` with an applicationId.
  const appScript =
    scripts.find(([, text]) => /applicationId/.test(text!))?.[1] ??
    scripts.find(([, text]) => /\bandroid\s*\{/.test(text!))?.[1] ??
    ''
  const allScripts = scripts.map(([, text]) => text).join('\n')

  const imports = new Set<string>()
  for (const [path, text] of Object.entries(files))
    if (path.endsWith('.kt') && text) for (const m of text.matchAll(IMPORT)) imports.add(m[1])
  const importsUnder = (prefix: string) => [...imports].some((i) => i.startsWith(prefix))
  const dependsOn = (pattern: RegExp) => pattern.test(allScripts)

  const manifestPath = Object.keys(files)
    .filter((p) => p.endsWith('AndroidManifest.xml'))
    .sort(
      (a, b) => Number(!a.includes('/main/')) - Number(!b.includes('/main/')) || a.length - b.length
    )[0]
  let manifest: KotlinRepoFacts['manifest'] = null
  if (manifestPath) {
    const xml = files[manifestPath] ?? ''
    const components = (tag: string) =>
      Array.from(xml.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g')), (m) =>
        attribute(m[1], 'name')
      ).filter((n): n is string => Boolean(n))
    const launcher = Array.from(xml.matchAll(/<activity\b([^>]*)>([\s\S]*?)<\/activity>/g)).find(
      (m) => /android\.intent\.category\.LAUNCHER/.test(m[2])
    )
    manifest = {
      path: manifestPath,
      application: /<application\b([^>]*)>/.exec(xml)
        ? attribute(/<application\b([^>]*)>/.exec(xml)![1], 'name')
        : null,
      launcher: launcher ? attribute(launcher[1], 'name') : null,
      activities: components('activity'),
      services: components('service'),
      receivers: components('receiver'),
      permissions: components('uses-permission'),
    }
  }

  const catalogPath = Object.keys(files).find((p) => p.endsWith('libs.versions.toml'))
  const catalog = catalogPath
    ? { path: catalogPath, ...readGradleCatalog(files[catalogPath] ?? '') }
    : null

  const ui = {
    compose: importsUnder('androidx.compose.') || dependsOn(/androidx\.compose|compose\s*=\s*true/),
    views:
      importsUnder('android.view.') ||
      importsUnder('android.widget.') ||
      importsUnder('androidx.appcompat.') ||
      importsUnder('androidx.fragment.') ||
      importsUnder('androidx.recyclerview.'),
  }
  const libraries = {
    room: importsUnder('androidx.room.'),
    coroutines: importsUnder('kotlinx.coroutines'),
    hilt: importsUnder('dagger.') || importsUnder('javax.inject.'),
    workManager: importsUnder('androidx.work.'),
    navigation: importsUnder('androidx.navigation.'),
    dataStore: importsUnder('androidx.datastore.'),
    retrofit: importsUnder('retrofit2.'),
  }
  const negativeFacts: string[] = []
  if (!ui.compose) negativeFacts.push('no Jetpack Compose')
  if (!libraries.room) negativeFacts.push('no Room')
  if (!libraries.coroutines) negativeFacts.push('no Kotlin coroutines')
  if (!libraries.hilt) negativeFacts.push('no Hilt or Dagger')
  if (!libraries.workManager) negativeFacts.push('no WorkManager')
  if (!libraries.navigation) negativeFacts.push('no Navigation component')
  if (!libraries.dataStore) negativeFacts.push('no DataStore')
  if (!libraries.retrofit) negativeFacts.push('no Retrofit')
  if (!manifest) negativeFacts.push('no AndroidManifest.xml')
  else if (manifest.permissions.length === 0) negativeFacts.push('no permissions declared')
  if (!catalog) negativeFacts.push('no version catalog')

  return {
    kotlinPluginVersion: pluginVersion(allScripts, /^org\.jetbrains\.kotlin\.|^android$|^jvm$/),
    androidGradlePluginVersion: pluginVersion(allScripts, /^com\.android\.(application|library)$/),
    android: {
      namespace: setting(appScript, ['namespace']),
      applicationId: setting(appScript, ['applicationId']),
      compileSdk: setting(appScript, ['compileSdk', 'compileSdkVersion']),
      minSdk: setting(appScript, ['minSdk', 'minSdkVersion']),
      targetSdk: setting(appScript, ['targetSdk', 'targetSdkVersion']),
    },
    manifest,
    ui,
    libraries,
    catalog,
    types: assembleKotlinTypes(parsed),
    negativeFacts,
  }
}

/** Members from every file are attributed to their type; extension functions to their receiver. */
export function assembleKotlinTypes(parsed: ParsedKotlinFile[]): KotlinTypeSurface[] {
  const types = new Map<string, KotlinTypeSurface>()
  const surface = (name: string): KotlinTypeSurface => {
    let t = types.get(name)
    if (!t) {
      t = {
        name,
        kind: 'unknown',
        declaredIn: null,
        supertypes: [],
        annotations: [],
        members: [],
        extensions: [],
      }
      types.set(name, t)
    }
    return t
  }
  for (const file of parsed) {
    for (const symbol of file.symbols as KotlinSymbol[]) {
      if (!['class', 'interface', 'enum'].includes(symbol.kind)) continue
      const t = surface(symbol.qualifiedName)
      t.kind = symbol.kind as KotlinTypeSurface['kind']
      t.declaredIn = file.path
      t.supertypes = symbol.supertypes ?? []
      t.annotations = symbol.annotations ?? []
    }
  }
  for (const file of parsed) {
    for (const symbol of file.symbols) {
      if (!symbol.parent || !['method', 'property', 'function', 'variable'].includes(symbol.kind))
        continue
      const t = surface(symbol.parent)
      if (!t.members.includes(symbol.name)) t.members.push(symbol.name)
      // A top-level `fun Receiver.name()` is an extension of Receiver from this file.
      if (symbol.kind === 'function') {
        let extension = t.extensions.find((e) => e.path === file.path)
        if (!extension) {
          extension = { path: file.path, members: [] }
          t.extensions.push(extension)
        }
        extension.members.push(symbol.name)
      }
    }
  }
  return Array.from(types.values())
}
