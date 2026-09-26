/**
 * A Gradle version catalog (`gradle/libs.versions.toml`): `[versions]` and
 * `[libraries]`, each library resolved to `group:name[:version]` with
 * `version.ref` followed. Build scripts reach an entry through an accessor
 * in which `-`, `_` and `.` in the alias all read as `.`
 * (`androidx-room-runtime` is `libs.androidx.room.runtime`).
 */
export interface GradleCatalog {
  versions: Record<string, string>
  libraries: Record<string, string>
}

export const isGradleCatalog = (path: string) => /(^|\/)[\w-]*\.versions\.toml$/.test(path)

/** The accessor a build script uses for an alias: `libs.` plus the alias with separators as dots. */
export const catalogAccessor = (alias: string, catalog = 'libs') =>
  `${catalog}.${alias.replace(/[-_]/g, '.')}`

export function readGradleCatalog(text: string): GradleCatalog {
  const versions: Record<string, string> = {}
  const libraries: Record<string, string> = {}
  let section = ''
  const pending: Array<[string, string]> = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s#.*$/, '').trim()
    const header = /^\[([\w-]+)\]$/.exec(line)
    if (header) {
      section = header[1]
      continue
    }
    const entry = /^([\w.\-]+)\s*=\s*(.+)$/.exec(line)
    if (!entry) continue
    if (section === 'versions') versions[entry[1]] = entry[2].replace(/^["']|["']$/g, '')
    if (section === 'libraries') pending.push([entry[1], entry[2]])
  }
  for (const [alias, value] of pending) {
    const quoted = /^["']([^"']+)["']$/.exec(value)
    if (quoted) {
      libraries[alias] = quoted[1]
      continue
    }
    const field = (name: string) =>
      new RegExp(`(?:^|[\\s{,])${name.replace('.', '\\.')}\\s*=\\s*["']([^"']+)["']`).exec(
        value
      )?.[1]
    const group = field('group')
    const name = field('name')
    const module = field('module') ?? (group && name ? `${group}:${name}` : null)
    if (!module) continue
    const ref = field('version.ref')
    const version = field('version') ?? (ref ? versions[ref] : undefined)
    libraries[alias] = version ? `${module}:${version}` : module
  }
  return { versions, libraries }
}
