/**
 * How the repository map's directory rows are laid out for the reader. Pure: the Inertia client
 * imports it, and the unit suite tests it without a browser.
 */
export interface MapDirectoryRow {
  path: string
  files: number
  symbols: number
}

export interface MapDirectoryGroup {
  /** The first path segment; `.` for files at the root. */
  top: string
  files: number
  symbols: number
  /** The rows below `top`; empty when the group is one directory. */
  children: MapDirectoryRow[]
}

/** Rows grouped under their first path segment, counts summed, most declarations first. */
export function groupDirectories(rows: MapDirectoryRow[]): MapDirectoryGroup[] {
  const groups = new Map<string, MapDirectoryGroup>()
  for (const row of rows) {
    const top = row.path.split('/')[0]
    const group = groups.get(top) ?? { top, files: 0, symbols: 0, children: [] }
    group.files += row.files
    group.symbols += row.symbols
    if (row.path !== top) group.children.push(row)
    groups.set(top, group)
  }
  return [...groups.values()].sort((x, y) => y.symbols - x.symbols || y.files - x.files)
}
