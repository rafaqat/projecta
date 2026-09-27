import { useMemo, useState } from 'react'
import { Head } from '@inertiajs/react'
import { Link } from '@adonisjs/inertia/react'
import { GitBranch, Lock, Search } from 'lucide-react'
import { Badge } from '~/components/ui/badge'
import { PageHeader } from '~/components/shell/page_header'
import { RegisterRepository } from '~/components/workspaces/register_repository'
import { SpendPanel } from '~/components/workspaces/spend_panel'

interface Props {
  workspace: { handle: string; name: string }
  repositories: Array<{ handle: string; name: string; url: string; visibility: string }>
  canManage: boolean
}

/** Case-insensitive match on the name or the URL; empty query keeps everything. */
export function matchesRepository(query: string, r: { name: string; url?: string }): boolean {
  const q = query.trim().toLowerCase()
  return !q || r.name.toLowerCase().includes(q) || (r.url ?? '').toLowerCase().includes(q)
}

export default function WorkspaceShow({ workspace, repositories, canManage }: Props) {
  const [query, setQuery] = useState('')
  const shown = useMemo(
    () => repositories.filter((r) => matchesRepository(query, r)),
    [repositories, query]
  )
  return (
    <>
      <Head title={workspace.name} />
      <PageHeader title="Repositories" />
      <div className="scroll flex-1 p-3">
        {canManage ? <RegisterRepository workspace={workspace.handle} /> : null}
        <SpendPanel workspace={workspace.handle} isOwner={canManage} />
        {repositories.length === 0 ? (
          <p className="px-2 py-6 text-content-muted">
            No repositories are visible to you in this workspace.
          </p>
        ) : (
          <label className="field mb-2 flex h-9 items-center gap-2 px-2.5 text-content-secondary">
            <Search className="h-3.5 w-3.5 flex-none text-content-muted" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Find a repository (${repositories.length})`}
              aria-label="Find a repository"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
              data-repository-filter
            />
          </label>
        )}
        {repositories.length > 0 && shown.length === 0 ? (
          <p className="px-2 py-6 text-content-muted" data-repository-empty>
            No repository matches &ldquo;{query.trim()}&rdquo;.
          </p>
        ) : null}
        <ul className="grid gap-1" data-repository-list>
          {shown.map((r) => (
            <li key={r.handle}>
              <Link
                href={`/w/${workspace.handle}/r/${r.handle}`}
                className="nav-item grid h-11 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 px-3 text-content-primary"
              >
                <GitBranch className="h-4 w-4" />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{r.name}</span>
                  <span className="mono block truncate text-content-muted">{r.url}</span>
                </span>
                {r.visibility === 'restricted' ? (
                  <Badge tone="warn" icon={Lock}>
                    restricted
                  </Badge>
                ) : (
                  <Badge>workspace</Badge>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
