import { createContext, useContext, useState, type ReactNode } from 'react'
import { DataTable, type Column } from './data_table'
import { AlertTriangle, ChevronDown, Copy } from 'lucide-react'
import { groupDirectories } from '../../../app/assistant/map_layout'
import { xsrfToken } from '../../lib/answer_stream'

/**
 * Re-indexing from inside an answer (the repository map's "references aren't indexed" notice).
 * Provided by the repository page only for readers who may manage the repository; absent, no
 * button renders. It forces a re-derivation, since the commit is already indexed.
 */
export const ReindexContext = createContext<(() => Promise<void>) | null>(null)

/**
 * Structured views (design §6, WP-11). Their data is produced by the
 * server's extractors and tools, never by model text; React's
 * escaping is the only rendering path, so repository-derived strings such as
 * paths and package names cannot reach the DOM as markup (SEC-08).
 */
/** How sure the index was of an edge: a guess by name is badged so it is never read as proof. */
export function ResolutionBadge({ resolution }: { resolution?: string }) {
  if (!resolution || resolution === 'exact' || resolution === 'alias') return null
  const label =
    resolution === 'heuristic'
      ? 'likely'
      : resolution === 'external'
        ? 'package'
        : resolution === 'unresolved'
          ? 'unresolved'
          : resolution
  return (
    <span
      className={`badge badge-${resolution}`}
      data-resolution={resolution}
      title={`resolution: ${resolution}`}
    >
      {label}
    </span>
  )
}

export interface EndpointRow {
  framework: string
  method: string
  path: string
  file: string
  line: number
  handler: string | null
}

export interface DependencyRow {
  ecosystem: string
  name: string
  version: string
  kind: string
  importers: string[]
  tier1_status: string
  /** The manifest the row was read from and the line of its declaration. */
  manifest?: string
  line?: number | null
}

export interface ManifestRow {
  path: string
  ecosystem: string
  status: 'read' | 'unread'
  dependencies: number
}

const ENDPOINT_COLUMNS: Array<Column<EndpointRow>> = [
  { key: 'method', label: 'Method', tone: 'muted', render: (e) => <code>{e.method}</code> },
  { key: 'path', label: 'Path', mono: true },
  { key: 'framework', label: 'Framework' },
  {
    key: 'declared',
    label: 'Declared at',
    render: (e) => (
      <>
        <code>
          {e.file}:{e.line}
        </code>
        {e.handler ? <span className="handler"> {e.handler}</span> : null}
      </>
    ),
  },
]

export function EndpointTable({ endpoints }: { endpoints: EndpointRow[] }) {
  return (
    <DataTable
      component="endpoint_table"
      className="endpoint-table"
      columns={ENDPOINT_COLUMNS}
      rows={endpoints}
      rowKey={(e) => `${e.method} ${e.path} ${e.file}:${e.line}`}
    />
  )
}

/**
 * Manifests first — read, with their row counts, or recognised and not read — then
 * package → importing files, grouped by kind; transitive packages fold under a summary.
 * An unread manifest is named so an empty package.json never reads as "self-contained"
 *.
 */
/**
 * Dependencies, laid out like the callers card (2026-09-17): stat tiles; the packages in
 * use ordered by how many indexed files import them, each expandable to those files; the ones
 * declared but never imported by an indexed file kept apart (a package can still be used from a
 * template or a script the index does not read); transitive packages as a count. Manifests first,
 * read or not, so an unread manifest never reads as "self-contained".
 */
export interface ShareEndpoints {
  create: string
  revoke: string
}

interface ShareLink {
  link: string
  format: string
  expiresAt: string
  url?: string
}

/**
 * Share links for this turn's BOM (WP-23): a link anyone can fetch for fifteen minutes
 * without signing in. Loaded only when opened, so an answer that is only read costs nothing. A new
 * link's URL is shown once — the server keeps only its hash — and the panel says plainly what a
 * holder of the link can see.
 */
function SharePanel({ endpoints }: { endpoints: ShareEndpoints }) {
  const [links, setLinks] = useState<ShareLink[] | null>(null)
  const [fresh, setFresh] = useState<ShareLink | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const until = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const request = async (url: string, init: RequestInit = {}) => {
    try {
      return await fetch(url, {
        ...init,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-XSRF-TOKEN': xsrfToken(),
        },
      })
    } catch (error) {
      setProblem(
        `The request did not complete: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
  }
  const load = async () => {
    const response = await request(endpoints.create)
    if (!response) return
    if (!response.ok) return setProblem(`Could not list links (${response.status}).`)
    setLinks(((await response.json()) as { links: ShareLink[] }).links)
  }
  const create = async (format: 'spdx' | 'cyclonedx') => {
    setProblem(null)
    const response = await request(endpoints.create, {
      method: 'POST',
      body: JSON.stringify({ format }),
    })
    if (!response) return
    if (response.status !== 201) return setProblem(`Could not create a link (${response.status}).`)
    const body = (await response.json()) as ShareLink & { path: string }
    setFresh({ ...body, url: `${window.location.origin}${body.path}` })
    await load()
  }
  const revoke = async (link: string) => {
    const response = await request(`${endpoints.revoke}/${link}`, { method: 'DELETE' })
    if (!response) return
    if (response.status !== 204)
      return setProblem(`Could not revoke the link (${response.status}).`)
    if (fresh?.link === link) setFresh(null)
    await load()
  }
  const button = 'rounded-md border border-line px-2 py-0.5 text-[12px] hover:bg-hover'
  return (
    <details
      className="mb-3 rounded-md border border-line px-3 py-2 text-[12.5px]"
      data-share
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open && links === null) void load()
      }}
    >
      <summary className="cursor-pointer font-medium">Share a link</summary>
      <p className="muted my-2">
        A link opens this BOM for 15 minutes to anyone who has it, without signing in. It shows the
        package list and which of this repository&rsquo;s files import each package.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={button}
          data-share-create="spdx"
          onClick={() => void create('spdx')}
        >
          Link to SPDX
        </button>
        <button
          type="button"
          className={button}
          data-share-create="cyclonedx"
          onClick={() => void create('cyclonedx')}
        >
          Link to CycloneDX BOM
        </button>
      </div>
      {fresh ? (
        <div className="mt-2 flex flex-wrap items-center gap-2" data-share-fresh>
          <input
            readOnly
            value={fresh.url}
            data-share-url
            aria-label="Share link"
            className="min-w-0 flex-1 rounded-md border border-line px-2 py-0.5 font-mono text-[12px]"
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            type="button"
            className={button}
            onClick={() => void navigator.clipboard?.writeText(fresh.url ?? '')}
          >
            Copy
          </button>
          <span className="muted">stops working at {until(fresh.expiresAt)} · shown once</span>
        </div>
      ) : null}
      {problem ? (
        <p className="mt-2 text-danger" role="alert" data-share-problem>
          {problem}
        </p>
      ) : null}
      {links && links.length > 0 ? (
        <ul className="m-0 mt-2 list-none p-0" data-share-links>
          {links.map((l) => (
            <li key={l.link} className="flex items-center gap-2" data-share-link={l.link}>
              <span>
                {l.format === 'spdx' ? 'SPDX' : 'CycloneDX'} · until {until(l.expiresAt)}
              </span>
              <button
                type="button"
                className={button}
                data-share-revoke
                onClick={() => void revoke(l.link)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  )
}

export function DependencyGraph({
  dependencies,
  manifests = [],
  summary,
  exportBase,
  share,
}: {
  dependencies: DependencyRow[]
  manifests?: ManifestRow[]
  /** Computed from the rows by the index; shown as the card's own sentence. */
  summary?: string
  /**
   * The dependency export of the commit this answer's turn was grounded at, without its format suffix:
   * `${exportBase}/spdx` (WP-21) and `${exportBase}/cyclonedx` (WP-22).
   */
  exportBase?: string
  /** Where this turn's share links are created and listed, and where one is revoked (WP-23). */
  share?: ShareEndpoints
}) {
  const unread = manifests.filter((m) => m.status === 'unread')
  const declared = dependencies.filter((d) => d.kind !== 'transitive')
  const used = declared
    .filter((d) => d.importers.length > 0)
    .sort((a, b) => b.importers.length - a.importers.length || a.name.localeCompare(b.name))
  const unused = declared.filter((d) => d.importers.length === 0)
  const transitive = dependencies.filter((d) => d.kind === 'transitive').length
  const maxImporters = Math.max(1, ...used.map((d) => d.importers.length))
  const stat = (label: string, value: number, warn = false) => (
    <div
      className={`rounded-lg px-3 py-2.5 ${warn ? 'bg-warning-wash' : 'bg-raised'}`}
      data-stat={label}
    >
      <dt className={`text-[12px] ${warn ? 'text-warning' : 'text-content-muted'}`}>{label}</dt>
      <dd
        className={`m-0 mt-0.5 text-[22px] font-medium tabular-nums ${warn ? 'text-warning' : ''}`}
      >
        {value}
      </dd>
    </div>
  )
  const site = (d: DependencyRow) =>
    d.manifest ? `${d.manifest.split('/').pop()}${d.line ? `:${d.line}` : ''}` : ''
  const row = (d: DependencyRow) => (
    <li
      key={`${d.ecosystem}:${d.name}:${d.manifest ?? ''}`}
      className="deps-row"
      data-tier1={d.tier1_status}
      data-kind={d.kind}
    >
      <details className="deps-dep">
        <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-1.5 py-1 text-[13px] hover:bg-hover">
          <span className="inline-flex flex-wrap items-baseline gap-2">
            <code>
              {d.name}@{d.version}
            </code>
            <span className="text-[12px] text-content-muted">
              {d.kind === 'dev' ? 'dev · ' : ''}
              {site(d)}
            </span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-[12px] tabular-nums text-content-muted">
            {d.importers.length > 0 ? (
              <>
                <span
                  className="inline-block h-1.5 rounded-sm bg-primary"
                  style={{ width: `${(d.importers.length / maxImporters) * 80}px` }}
                />
                {d.importers.length} file{d.importers.length === 1 ? '' : 's'}
              </>
            ) : (
              <span className="text-warning">not imported</span>
            )}
          </span>
        </summary>
        {d.importers.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-0.5 px-1.5 pb-2 pl-5 pt-0.5 text-[12px]">
            {d.importers.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 px-1.5 pb-2 pl-5 pt-0.5 text-[12px] text-content-muted">
            No indexed file imports it. It may be used from a template, a script or the browser,
            which the index does not read, or it may be unused.
          </p>
        )}
      </details>
    </li>
  )
  return (
    <div className="view dependency-graph" data-component="dependency_graph">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="m-0 text-[14px] font-medium">Dependencies</h3>
        <span className="flex-1" />
        <span className="text-[12px] text-content-muted">
          From the manifests and the import index, not model text
        </span>
        {exportBase ? (
          <>
            <a
              href={`${exportBase}/spdx`}
              download
              data-export="spdx"
              className="rounded-md border border-line px-2 py-0.5 text-[12px] hover:bg-hover"
              title="SPDX 2.3 for this commit: versions only where a lockfile pinned them, importing files for each package, and every manifest that could not be read"
            >
              Export as SPDX
            </a>
            <a
              href={`${exportBase}/cyclonedx`}
              download
              data-export="cyclonedx"
              className="rounded-md border border-line px-2 py-0.5 text-[12px] hover:bg-hover"
              title="CycloneDX 1.6 BOM for this commit, with each package's importing files as evidence and a statement of whether the inventory is complete"
            >
              Export BOM as CycloneDX
            </a>
          </>
        ) : null}
      </div>
      {exportBase ? (
        <p className="m-0 mb-3 text-[12px] text-content-muted" data-export-hint>
          CycloneDX is the BOM format tools like Dependency-Track import.
        </p>
      ) : null}
      {share ? <SharePanel endpoints={share} /> : null}
      {manifests.length > 0 ? (
        <ul className="manifests m-0 mb-3 list-none p-0 text-[12.5px]" data-manifests>
          {manifests.map((m) => (
            <li key={m.path} data-status={m.status}>
              <code>{m.path}</code>{' '}
              {m.status === 'read' ? (
                <span className="muted">
                  {m.ecosystem}, {m.dependencies}{' '}
                  {m.dependencies === 1 ? 'dependency' : 'dependencies'}
                </span>
              ) : (
                <span className="muted">{m.ecosystem}, not read: no reader for this manifest</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {unread.length > 0 && dependencies.length === 0 ? (
        <p className="muted">
          No dependencies were read; the manifests above were recognised but not read.
        </p>
      ) : null}
      {summary ? (
        <p className="m-0 mb-3 text-[13px] text-content-secondary" data-summary>
          {summary}
        </p>
      ) : null}
      {declared.length > 0 ? (
        <dl className="m-0 mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4" data-stats>
          {stat('Direct', declared.filter((d) => d.kind === 'direct').length)}
          {stat('Dev', declared.filter((d) => d.kind === 'dev').length)}
          {stat('Transitive', transitive)}
          {stat('Declared, not imported', unused.length, unused.length > 0)}
        </dl>
      ) : null}
      {used.length > 0 ? (
        <details className="deps-panel rounded-[10px] border border-line" open data-panel="used">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 font-medium">
            In use
            <span className="text-[12px] font-normal text-content-muted">
              {used.length} package{used.length === 1 ? '' : 's'}, by how many indexed files import
              them
            </span>
            <span className="flex-1" />
            <ChevronDown className="callers-chev h-4 w-4 text-content-muted" />
          </summary>
          <ul className="m-0 list-none px-2 pb-2 pt-1">{used.map(row)}</ul>
        </details>
      ) : null}
      {unused.length > 0 ? (
        <details
          className="deps-panel mt-2 rounded-[10px] border border-line"
          open
          data-panel="unused"
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 font-medium">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
            Declared but not imported by an indexed file
            <span className="text-[12px] font-normal text-content-muted">
              {unused.filter((d) => d.kind === 'direct').length} runtime,{' '}
              {unused.filter((d) => d.kind === 'dev').length} dev
            </span>
            <span className="flex-1" />
            <ChevronDown className="callers-chev h-4 w-4 text-content-muted" />
          </summary>
          <ul className="m-0 list-none px-2 pb-2 pt-1">
            {[...unused]
              .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
              .map(row)}
          </ul>
        </details>
      ) : null}
      {transitive > 0 ? (
        <p className="m-0 mt-2 text-[12.5px] text-content-muted" data-transitive>
          {transitive} transitive packages from the lockfile are not listed.
        </p>
      ) : null}
    </div>
  )
}

export interface OutlineSymbolRow {
  kind: string
  name: string
  qualifiedName: string
  startLine: number
  endLine: number
}

/** A file's declarations at the commit, in line order ('s shape for "what is implemented in"). */
export function FileOutline({
  path,
  lines,
  symbols,
}: {
  path: string
  lines: number
  symbols: OutlineSymbolRow[]
}) {
  return (
    <div className="view file-outline" data-component="file_outline">
      <div className="muted">
        <code>{path}</code> · {lines} lines · {symbols.length}{' '}
        {symbols.length === 1 ? 'declaration' : 'declarations'}
      </div>
      {symbols.length === 0 ? (
        <p className="muted">No declarations: a region without functions or classes.</p>
      ) : (
        <DataTable
          component="file_outline"
          className="file-outline-table"
          columns={OUTLINE_COLUMNS}
          rows={symbols}
          rowKey={(s) => `${s.qualifiedName}:${s.startLine}`}
        />
      )}
    </div>
  )
}

const OUTLINE_COLUMNS: Array<Column<OutlineSymbolRow>> = [
  { key: 'kind', label: 'Kind', tone: 'muted' },
  { key: 'qualifiedName', label: 'Declaration', mono: true },
  {
    key: 'lines',
    label: 'Lines',
    align: 'right',
    render: (s) => (
      <code>
        {s.startLine}–{s.endLine}
      </code>
    ),
  },
]

export interface RepoMapData {
  files: number
  indexed: number
  /** Absent on maps emitted before 2026-09-16. */
  unindexed?: Array<{ ext: string; files: number }>
  referencesIndexed?: boolean
  languages: Record<string, number>
  directories: Array<{
    path: string
    files: number
    symbols: number
    languages: Record<string, number>
  }>
  entryPoints: Array<{ path: string; why: string }>
  hubs: Array<{ qualifiedName: string; path: string; references: number }>
  mostImported: Array<{ module: string; importers: number }>
  endpoints: number
  manifests: Array<{ path: string; status: string }>
  tests: { files: number }
  readme: { path: string; sections: string[] } | null
}

const VISIBLE_DIRECTORY_GROUPS = 5

/**
 * The repository at the commit, from the index: counts, what the index does not hold, directories
 * grouped by their top level, entry points, hubs, imports (UAT 2026-09-16, StyleSwap).
 */
export function RepoMapView({ map }: { map: RepoMapData }) {
  const [showAll, setShowAll] = useState(false)
  const reindex = useContext(ReindexContext)
  const [reindexing, setReindexing] = useState<'idle' | 'queued'>('idle')
  const groups = groupDirectories(map.directories)
  const visible = showAll ? groups : groups.slice(0, VISIBLE_DIRECTORY_GROUPS)
  const declarations = map.directories.reduce((n, d) => n + d.symbols, 0)
  const unindexed = (map.unindexed ?? []).map((u) => `${u.ext} ${u.files}`).join(', ')
  const referencesIndexed = map.referencesIndexed ?? map.hubs.length > 0
  const stats: Array<[string, number, boolean]> = [
    ['Files', map.files, false],
    ['Endpoints', map.endpoints, false],
    ['Declarations', declarations, false],
    ['Test files', map.tests.files, map.tests.files === 0],
  ]
  return (
    <div
      className="view repo-map my-3 rounded-lg border border-line bg-card p-4"
      data-component="repo_map"
    >
      <div className="mb-3 flex items-center gap-2 text-sm">
        <span className="font-semibold">Repository structure</span>
        <span className="flex-1" />
        <span className="text-xs text-content-muted">From the index, not model text</span>
      </div>
      <dl className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stats.map(([label, value, warn]) => (
          <div
            key={label}
            className={`rounded-md px-3 py-2 ${warn ? 'bg-warning-wash text-warning' : 'bg-hover'}`}
            data-stat={label}
          >
            <dt className={`text-xs ${warn ? '' : 'text-content-muted'}`}>{label}</dt>
            <dd className="text-xl font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mb-3" data-coverage>
        <div className="mb-1 flex flex-wrap justify-between gap-x-3 text-xs">
          <span>Index coverage</span>
          <span className="text-content-muted">
            {map.indexed} of {map.files} files{unindexed ? ` · not indexed: ${unindexed}` : ''}
          </span>
        </div>
        <div
          className="h-1.5 overflow-hidden rounded bg-hover"
          role="progressbar"
          aria-label="Index coverage"
          aria-valuemin={0}
          aria-valuemax={map.files}
          aria-valuenow={map.indexed}
        >
          <div
            className="h-full bg-primary"
            style={{ width: `${map.files ? Math.round((map.indexed / map.files) * 100) : 0}%` }}
          />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="text-left text-xs text-content-muted">
              <th className="pb-1 font-normal">Directory</th>
              <th className="pb-1 text-right font-normal">Files</th>
              <th className="pb-1 text-right font-normal">Declarations</th>
            </tr>
          </thead>
          <tbody>
            {visible.flatMap((g) => [
              <tr key={g.top} className="border-t border-line" data-directory-group={g.top}>
                <td className="py-1">
                  <code>{g.top === '.' ? '(root)' : `${g.top}/`}</code>
                </td>
                <td className="py-1 text-right">{g.files}</td>
                <td className="py-1 text-right">{g.symbols}</td>
              </tr>,
              ...g.children.map((c) => (
                <tr
                  key={c.path}
                  className="border-t border-dashed border-line text-content-secondary"
                >
                  <td className="py-1 pl-4">
                    <code>{c.path.slice(g.top.length + 1)}/</code>
                  </td>
                  <td className="py-1 text-right">{c.files}</td>
                  <td className="py-1 text-right">{c.symbols}</td>
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
      {groups.length > VISIBLE_DIRECTORY_GROUPS ? (
        <button
          type="button"
          className="mt-1 text-xs text-primary"
          aria-expanded={showAll}
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? 'Show fewer' : `Show ${groups.length - VISIBLE_DIRECTORY_GROUPS} more`}
        </button>
      ) : null}
      {map.entryPoints.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-sm">
          <span className="text-xs text-content-muted">Entry points</span>
          {map.entryPoints.map((e) => (
            <span key={e.path} className="rounded bg-hover px-2 py-0.5" title={e.why}>
              <code>{e.path}</code> <span className="text-xs text-content-muted">{e.why}</span>
            </span>
          ))}
        </div>
      ) : null}
      {map.hubs.length > 0 ? (
        <p className="mt-2 text-sm">
          Most referenced:{' '}
          {map.hubs.map((h, i) => (
            <span key={h.qualifiedName}>
              {i > 0 ? ', ' : ''}
              <code>{h.qualifiedName}</code> <span className="muted">({h.references})</span>
            </span>
          ))}
        </p>
      ) : null}
      {map.mostImported.length > 0 ? (
        <p className="mt-2 text-sm">
          Most imported:{' '}
          {map.mostImported.map((m, i) => (
            <span key={m.module}>
              {i > 0 ? ', ' : ''}
              <code>{m.module}</code> <span className="muted">({m.importers})</span>
            </span>
          ))}
        </p>
      ) : null}
      {map.readme ? (
        <p className="mt-2 text-sm">
          README <code>{map.readme.path}</code>
          {map.readme.sections.length ? (
            <span className="muted"> · {map.readme.sections.join(' · ')}</span>
          ) : null}
        </p>
      ) : null}
      {!referencesIndexed ? (
        <div
          className="scope-notice flex flex-wrap items-center gap-3 text-sm"
          role="status"
          data-references-indexed="false"
        >
          <span className="min-w-0 flex-1">
            References aren’t indexed for this commit, so calls between files and the most
            referenced symbols can’t be shown. Re-index the repository to add them.
          </span>
          {reindex ? (
            <button
              type="button"
              className="outline-ring h-7 rounded px-2.5 text-xs"
              disabled={reindexing !== 'idle'}
              onClick={() => {
                setReindexing('queued')
                reindex().catch(() => setReindexing('idle'))
              }}
              data-reindex-from-map
            >
              {reindexing === 'queued' ? 'Re-index queued' : 'Re-index'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export interface LocatedSymbolRow {
  qualifiedName: string
  kind: string
  path: string
  startLine: number
  endLine: number
  score: number
  why: string[]
  endpoints: string[]
}

/** The declarations that implement a feature, ranked by the index and grouped by layer. */
export function FeatureMap({
  words,
  layers,
}: {
  words: string[]
  layers: Array<{ layer: string; symbols: LocatedSymbolRow[] }>
}) {
  return (
    <div className="view feature-map" data-component="feature_map">
      <div className="muted">
        Feature map for{' '}
        {words.map((w) => (
          <code key={w}>{w} </code>
        ))}
      </div>
      {layers.length === 0 ? (
        <p className="muted">Nothing at this commit names these words.</p>
      ) : (
        layers.map((l) => (
          <div key={l.layer} className="layer" data-layer={l.layer}>
            <div className="layer-name">{l.layer}</div>
            <ul>
              {l.symbols.map((s) => (
                <li key={`${s.path}:${s.startLine}`}>
                  <code>{s.qualifiedName}</code>{' '}
                  <span className="muted">
                    {s.kind} · {s.path}:{s.startLine}
                    {s.endLine > s.startLine ? `–${s.endLine}` : ''} · {s.why.join(', ')}
                  </span>
                  {s.endpoints.length ? (
                    <div className="muted">{s.endpoints.join(', ')}</div>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  )
}

export interface FlowTraceData {
  referencesIndexed: boolean
  root: { qualifiedName: string; path: string; startLine: number } | null
  entry?: { via: string; hops: number } | null
  edges: Array<{
    from: string
    to: string
    kind: string
    resolution?: string
    path: string
    line: number
    depth: number
  }>
  pruned?: number
  unresolved?: { calls: number; files: number }
}

/** The call flow from a symbol or an entry file: the resolved references, callees first, each badged by tier. */
export function FlowTrace({ flow }: { flow: FlowTraceData }) {
  return (
    <div className="view flow-trace" data-component="flow_trace">
      <div className="muted">
        From{' '}
        <code>
          {flow.root?.qualifiedName === '<file>' ? flow.root.path : flow.root?.qualifiedName}
        </code>
        {flow.root && flow.root.qualifiedName !== '<file>' ? (
          <span>
            {' '}
            · {flow.root.path}:{flow.root.startLine}
          </span>
        ) : null}
      </div>
      {flow.entry?.via === 'callers' ? (
        <p className="muted">Entry reached by walking {flow.entry.hops} caller hop(s) up.</p>
      ) : null}
      {!flow.referencesIndexed ? (
        <p className="muted">
          References are not indexed for this commit: re-index to trace calls.
        </p>
      ) : flow.edges.length === 0 ? (
        <p className="muted">No resolved calls from here.</p>
      ) : (
        <ul className="flow">
          {flow.edges.map((e, i) => (
            <li key={`${e.path}:${e.line}:${i}`} data-depth={Math.min(e.depth, 4)}>
              <code>{e.from}</code> → <code>{e.to}</code> <span className="muted">[{e.kind}]</span>{' '}
              <ResolutionBadge resolution={e.resolution} />{' '}
              <code>
                {e.path}:{e.line}
              </code>
            </li>
          ))}
        </ul>
      )}
      {flow.pruned || flow.unresolved?.calls ? (
        <p className="muted">
          {flow.pruned ? `${flow.pruned} utility call(s) hidden. ` : ''}
          {flow.unresolved?.calls
            ? `${flow.unresolved.calls} call(s) in ${flow.unresolved.files} file(s) could not be resolved.`
            : ''}
        </p>
      ) : null}
    </div>
  )
}

export interface CloneClassRow {
  id: string
  type: number
  classification: 'duplicate' | 'pattern'
  method: string
  similarity: number
  members: Array<{
    path: string
    qualifiedName: string
    startLine: number
    endLine: number
    divergence: Array<{ start: number; end: number }>
  }>
}

const TYPE_LABEL: Record<number, string> = { 1: 'exact', 2: 'renamed', 3: 'near miss' }

/** Clone classes with detection-method badges; near-miss members list the lines the representative does not share. */
export function CloneClassView({ classes }: { classes: CloneClassRow[] }) {
  return (
    <div className="view clone-classes" data-component="clone_class">
      {classes.map((c) => (
        <section key={c.id} className={`clone-class clone-${c.classification}`} data-type={c.type}>
          <header>
            <span className="badge">{c.classification}</span>
            <span className="badge">
              type {c.type}: {TYPE_LABEL[c.type] ?? 'unknown'}
            </span>
            <span className="badge" data-method={c.method}>
              {c.method} · {(c.similarity * 100).toFixed(0)}%
            </span>
          </header>
          <div className="clone-members">
            {c.members.map((m) => (
              <div key={`${m.path}:${m.startLine}`} className="clone-member">
                <code>
                  {m.path}:{m.startLine}-{m.endLine}
                </code>
                <div>{m.qualifiedName}</div>
                {m.divergence.length > 0 ? (
                  <ul className="divergence">
                    {m.divergence.map((d) => (
                      <li key={d.start}>
                        differs at line{d.end > d.start ? `s ${d.start}-${d.end}` : ` ${d.start}`}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export interface UsageRow {
  resolution?: string
  definition?: { path: string; line: number } | null
  path: string
  line: number
  snippet: string
  symbol: string | null
  kind?: 'call' | 'new' | 'reference'
}

export interface CalleeRow {
  path: string
  line: number
  symbol: string
  kind: 'call' | 'new' | 'reference'
}

/** Every use of an identifier at the commit, from the index (design §6); the model's prose follows it. */
/**
 * Callers of a symbol, grouped by the definition each call resolves to (CallersCard design,
 * 2026-09-17): a name defined three times, each file calling its own copy, is three panels, not
 * one 48-row table. Stat tiles first; unresolved calls kept apart from the resolved graph; a
 * duplicates hint when same-named definitions share a folder. Everything here is index data.
 */
export function UsageTable({
  identifier,
  definitions,
  usages,
  callees = [],
  total,
  referencesIndexed = true,
  unresolved,
  onAsk,
}: {
  identifier: string
  definitions: Array<{ path: string; line: number; symbol: string }>
  usages: UsageRow[]
  callees?: CalleeRow[]
  total: number
  referencesIndexed?: boolean
  unresolved?: { calls: number; files: number; named?: { calls: number; files: number } }
  onAsk?: (q: string) => void
}) {
  const hidden = unresolved?.named ?? { calls: 0, files: 0 }
  const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)
  const dir = (p: string) => p.slice(0, p.lastIndexOf('/'))
  // Sites by the definition they resolve to; sites with none go under the first definition.
  const panels = definitions.map((d, i) => {
    const mine = usages.filter((u) =>
      u.definition
        ? u.definition.path === d.path && u.definition.line === d.line
        : i === 0 && definitions.length === 1
    )
    const byFn = new Map<string, UsageRow[]>()
    for (const u of mine) byFn.set(u.symbol ?? '', [...(byFn.get(u.symbol ?? '') ?? []), u])
    return { ...d, callers: [...byFn.entries()].map(([fn, calls]) => ({ fn, calls })) }
  })
  const orphans = usages.filter((u) => !u.definition && definitions.length !== 1)
  const callingFunctions = new Set(usages.map((u) => `${u.path}#${u.symbol ?? ''}`)).size
  const maxCallers = Math.max(1, ...panels.map((p) => p.callers.length))
  const sameFolder =
    definitions.length > 1 && new Set(definitions.map((d) => dir(d.path))).size === 1
  const stat = (label: string, value: number, warn = false) => (
    <div
      className={`rounded-lg px-3 py-2.5 ${warn ? 'bg-warning-wash' : 'bg-raised'}`}
      data-stat={label}
    >
      <dt className={`text-[12px] ${warn ? 'text-warning' : 'text-content-muted'}`}>{label}</dt>
      <dd
        className={`m-0 mt-0.5 text-[22px] font-medium tabular-nums ${warn ? 'text-warning' : ''}`}
      >
        {value}
      </dd>
    </div>
  )
  return (
    <div className="view usage-table" data-component="usage_table" data-identifier={identifier}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="m-0 text-[14px] font-medium">
          Callers of <code>{identifier}</code>
        </h3>
        <span className="flex-1" />
        <span className="text-[12px] text-content-muted">
          From the reference index, not model text
        </span>
      </div>
      {!referencesIndexed ? (
        <p className="m-0 text-[12.5px] text-content-secondary">
          References were not indexed for this commit yet: re-index the repository to see who calls
          it.
        </p>
      ) : null}
      <dl className="m-0 mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4" data-stats>
        {stat('Definitions', definitions.length)}
        {stat('Calling functions', callingFunctions)}
        {stat('Resolved calls', total)}
        {stat(`Unresolved calls to ${identifier.split('.').pop()}`, hidden.calls, hidden.calls > 0)}
      </dl>
      <div className="flex flex-col gap-2" data-definitions>
        {panels.map((d) => (
          <details
            key={`${d.path}:${d.line}`}
            className="callers-def rounded-[10px] border border-line"
            open
            data-definition={`${d.path}:${d.line}`}
          >
            <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto_16px] items-center gap-3 px-3 py-2.5">
              <span className="inline-flex flex-wrap items-baseline gap-2 font-medium">
                <code>{base(d.path)}</code>
                <span className="text-[12px] font-normal text-content-muted">
                  {dir(d.path)} · defined at line {d.line}
                </span>
              </span>
              <span className="inline-flex items-center gap-1.5 text-[12px] tabular-nums text-content-muted">
                <span
                  className="callers-bar inline-block h-1.5 rounded-sm bg-primary"
                  style={{ width: `${(d.callers.length / maxCallers) * 80}px` }}
                />
                {d.callers.length} function{d.callers.length === 1 ? '' : 's'}
              </span>
              <ChevronDown className="callers-chev h-4 w-4 text-content-muted" />
            </summary>
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-x-4 gap-y-0.5 px-3 pb-2.5 pt-2">
              {d.callers.map((f) => (
                <li key={f.fn || '(file)'} className="callers-fn">
                  <details className="callers-caller">
                    <summary className="flex cursor-pointer list-none items-baseline justify-between gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-hover">
                      {f.fn ? <code>{f.fn}</code> : <span className="muted">file top level</span>}
                      <span className="text-[12px] text-content-muted">
                        {f.calls.length === 1 ? 'line' : 'lines'}{' '}
                        {f.calls.map((x) => x.line).join(', ')}
                      </span>
                    </summary>
                    <ul className="m-0 flex list-none flex-col gap-0.5 px-1.5 pb-2 pl-4 pt-0.5">
                      {f.calls.map((x) => (
                        <li
                          key={x.line}
                          className="grid grid-cols-[44px_minmax(0,1fr)] gap-2 text-[12px]"
                          data-resolution={x.resolution ?? 'exact'}
                        >
                          <code className="text-content-muted">:{x.line}</code>
                          <code className="[overflow-wrap:anywhere]">
                            {x.snippet} <ResolutionBadge resolution={x.resolution} />
                          </code>
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
          </details>
        ))}
        {orphans.length ? (
          <p className="m-0 text-[12.5px] text-content-secondary" data-unplaced>
            {orphans.length} site{orphans.length === 1 ? '' : 's'} could not be placed under a
            definition.
          </p>
        ) : null}
      </div>
      {hidden.calls > 0 ? (
        <div
          className="mt-3 flex flex-wrap items-center gap-2.5 rounded-lg bg-warning-wash px-3 py-2 text-[13px] text-warning"
          role="status"
          data-unresolved
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            {hidden.calls} call{hidden.calls === 1 ? '' : 's'} named <code>{identifier}</code> in{' '}
            {hidden.files} file{hidden.files === 1 ? '' : 's'} could not be resolved to a definition
            in the index, so callers among them cannot be listed. Never read this as “unused”.
          </span>
        </div>
      ) : (
        <p className="m-0 mt-3 text-[12.5px] text-content-secondary" data-unresolved-none>
          Every call named <code>{identifier}</code> at this commit resolves to a definition above.
        </p>
      )}
      {unresolved && unresolved.calls > 0 ? (
        <p className="m-0 mt-1.5 text-[12px] text-content-muted" data-unresolved-commit>
          Separately, {unresolved.calls} call{unresolved.calls === 1 ? '' : 's'} in{' '}
          {unresolved.files} file{unresolved.files === 1 ? '' : 's'} across the commit could not be
          resolved (package and browser APIs, mostly): a general limit of the index, not hidden
          callers of <code>{identifier}</code>.
        </p>
      ) : null}
      {sameFolder ? (
        <div
          className="mt-2 flex flex-wrap items-center gap-2.5 rounded-lg bg-raised px-3 py-2 text-[13px] text-content-muted"
          data-duplicates-hint
        >
          <Copy className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            {definitions.length} definitions with the same name in one folder.
          </span>
          <button
            type="button"
            className="rounded-md border border-line px-2.5 py-1 text-[12px] text-content-primary hover:bg-hover"
            onClick={() => onAsk?.(`Are there duplicates of \`${identifier}\`?`)}
            data-check-duplicates
          >
            Check for duplicates
          </button>
        </div>
      ) : null}
      {callees.length ? (
        <p className="m-0 mt-2 text-[12.5px] text-content-secondary" data-callees>
          Its body calls{' '}
          {callees.map((c, i) => (
            <span key={i}>
              {i ? ', ' : ''}
              <code>{c.symbol}</code>
              <span className="muted">
                {' '}
                ({c.path.split('/').pop()}:{c.line})
              </span>
            </span>
          ))}
          .
        </p>
      ) : null}
    </div>
  )
}

export interface WithheldSpanData {
  reason: 'connective_budget' | 'background_budget' | 'quoted_comment'
  sentences: number
  characters: number
  budget: { used: number; limit: number }
  names: Array<{ name: string; inCommit: boolean }>
  routes: number
  followUps: string[]
}

const WITHHELD_REASON: Record<WithheldSpanData['reason'], string> = {
  connective_budget:
    'it cited no code, and the answer had already used its allowance of uncited sentences',
  background_budget: 'it was general background beyond the allowance for this answer',
  quoted_comment:
    'it repeated a comment from the code word for word without citing it, which is how an instruction planted in a comment would surface',
}

/**
 * Where the gate withheld model text: how much, why, what it mentioned — each name
 * checked against the commit — and questions that would get it answered from code. The withheld
 * text itself is never shown.
 */
export function WithheldSpan({
  span,
  onAsk,
}: {
  span: WithheldSpanData
  onAsk?: (q: string) => void
}) {
  const unit = span.reason === 'background_budget' ? 'background words' : 'uncited sentences'
  return (
    <div
      className="withheld-span my-2 rounded border border-dashed border-line px-3 py-2 text-[13px] text-content-muted"
      data-component="withheld_span"
      data-reason={span.reason}
      data-sentences={span.sentences}
    >
      <p>
        ⋯ {span.sentences} sentence{span.sentences === 1 ? '' : 's'} ({span.characters} characters)
        held back here: {WITHHELD_REASON[span.reason]} ({span.budget.used} of {span.budget.limit}{' '}
        {unit} used).
      </p>
      {span.names.length ? (
        <p data-withheld-names>
          {span.routes ? `Mentioned ${span.routes} route${span.routes === 1 ? '' : 's'}; ` : ''}
          names mentioned:{' '}
          {span.names.map((n, i) => (
            <span key={n.name} data-in-commit={String(n.inCommit)}>
              {i ? ', ' : ''}
              <code>{n.name}</code> {n.inCommit ? '(in this commit)' : '(not found in this commit)'}
            </span>
          ))}
          . These are names only; nothing said about them was checked.
        </p>
      ) : null}
      {span.followUps.length ? (
        <div className="mt-1">
          <span>Ask to get this answered from the code: </span>
          <ul className="suggestions inline">
            {span.followUps.map((q) => (
              <li key={q}>
                <button type="button" onClick={() => onAsk?.(q)} data-withheld-follow-up>
                  {q}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

export interface SetProgressData {
  set: string
  total: number
  from: number
  to: number
  next: string | null
}

/** A set question's progress: which rows this turn explained, and the question that continues it. */
export function SetProgress({
  data,
  onAsk,
}: {
  data: SetProgressData
  onAsk?: (q: string) => void
}) {
  return (
    <div
      className="set-progress my-2 flex flex-wrap items-center gap-2 text-[13px] text-content-muted"
      data-component="set_progress"
      data-from={data.from}
      data-to={data.to}
      data-total={data.total}
    >
      <span>
        This answer covers {data.set} {data.from}–{data.to} of {data.total}
        {data.next
          ? `: ${data.total - data.to} remaining, one batch per question.`
          : ': the set is complete.'}
      </span>
      {data.next ? (
        <ul className="suggestions">
          <li>
            <button type="button" onClick={() => onAsk?.(data.next!)} data-set-continue>
              {data.next} →
            </button>
          </li>
        </ul>
      ) : null}
    </div>
  )
}

type ViewRecord = Record<string, unknown>
type OnAsk = ((q: string) => void) | undefined

/**
 * The view registry: each view id maps to a shape guard and a renderer. Adding a view is
 * one entry here plus its component — the dispatcher never grows a branch. The ids are the server's
 * (`VIEW_COMPONENTS` in protocol.ts); the model cannot introduce one.
 */
/**
 * What a view may need beyond its own data: where the repository's API lives, and the handle of
 * the turn it belongs to (a download is keyed by the turn, never by a commit SHA — INV-10).
 */
export interface ViewContext {
  apiBase?: string
  turnHandle?: string
}

export const VIEWS: Record<
  string,
  {
    match: (r: ViewRecord) => boolean
    render: (r: ViewRecord, onAsk: OnAsk, ctx: ViewContext) => ReactNode
  }
> = {
  set_progress: {
    match: (r) => typeof r.total === 'number',
    render: (r, onAsk) => <SetProgress data={r as unknown as SetProgressData} onAsk={onAsk} />,
  },
  withheld_span: {
    match: (r) => typeof r.sentences === 'number',
    render: (r, onAsk) => <WithheldSpan span={r as unknown as WithheldSpanData} onAsk={onAsk} />,
  },
  usage_table: {
    match: (r) => Array.isArray(r.usages),
    render: (r, onAsk) => (
      <UsageTable
        identifier={String(r.identifier)}
        definitions={(r.definitions ?? []) as Array<{ path: string; line: number; symbol: string }>}
        usages={r.usages as UsageRow[]}
        callees={(r.callees ?? []) as CalleeRow[]}
        total={Number(r.total ?? (r.usages as UsageRow[]).length)}
        referencesIndexed={r.referencesIndexed !== false}
        unresolved={r.unresolved as { calls: number; files: number } | undefined}
        onAsk={onAsk}
      />
    ),
  },
  clone_class: {
    match: (r) => Array.isArray(r.classes),
    render: (r) => <CloneClassView classes={r.classes as CloneClassRow[]} />,
  },
  endpoint_table: {
    match: (r) => Array.isArray(r.endpoints),
    render: (r) => <EndpointTable endpoints={r.endpoints as EndpointRow[]} />,
  },
  flow_trace: {
    match: (r) => Array.isArray(r.edges),
    render: (r) => <FlowTrace flow={r as unknown as FlowTraceData} />,
  },
  feature_map: {
    match: (r) => Array.isArray(r.layers),
    render: (r) => (
      <FeatureMap
        words={Array.isArray(r.words) ? (r.words as string[]) : []}
        layers={r.layers as Array<{ layer: string; symbols: LocatedSymbolRow[] }>}
      />
    ),
  },
  repo_map: {
    match: (r) => Array.isArray(r.directories),
    render: (r) => <RepoMapView map={r as unknown as RepoMapData} />,
  },
  file_outline: {
    match: (r) => Array.isArray(r.symbols),
    render: (r) => (
      <FileOutline
        path={String(r.path)}
        lines={Number(r.lines ?? 0)}
        symbols={r.symbols as OutlineSymbolRow[]}
      />
    ),
  },
  dependency_graph: {
    match: (r) => Array.isArray(r.dependencies),
    render: (r, _onAsk, ctx) => (
      <DependencyGraph
        dependencies={r.dependencies as DependencyRow[]}
        manifests={Array.isArray(r.manifests) ? (r.manifests as ManifestRow[]) : []}
        summary={typeof r.summary === 'string' ? r.summary : undefined}
        exportBase={
          ctx.apiBase && ctx.turnHandle
            ? `${ctx.apiBase}/turns/${ctx.turnHandle}/dependencies`
            : undefined
        }
        share={
          ctx.apiBase && ctx.turnHandle
            ? {
                create: `${ctx.apiBase}/turns/${ctx.turnHandle}/dependencies/links`,
                revoke: `${ctx.apiBase}/dependencies/links`,
              }
            : undefined
        }
      />
    ),
  },
}

export function StructuredView({
  component,
  data,
  onAsk,
  apiBase,
  turnHandle,
}: {
  component: string
  data: unknown
  onAsk?: (q: string) => void
  apiBase?: string
  turnHandle?: string
}) {
  const record = (data ?? {}) as ViewRecord
  const view = VIEWS[component]
  if (view && view.match(record)) return <>{view.render(record, onAsk, { apiBase, turnHandle })}</>
  // scope_notice is rendered by the answer card directly (it is a notice, not a data view); any
  // other id, or data that does not match its view, falls back to a readable dump.
  return (
    <pre className="view" data-component={component}>
      {JSON.stringify(data, null, 2)}
    </pre>
  )
}
