import { Head } from '@inertiajs/react'
import { useMemo, useState, type ReactElement } from 'react'
import { Copy, GitCommitHorizontal } from 'lucide-react'
import { PageHeader } from '../../components/shell/page_header'
import { GroupDetail, type CloneGroup } from '../../components/duplicates/group_detail'

type Group = CloneGroup
interface Props {
  workspace: { handle: string; name: string }
  repository: { handle: string; name: string }
  commitSha: string | null
  groups: Group[]
  assetsVersion?: string
}

const shortPath = (p: string) => {
  const at = p.lastIndexOf('/')
  return { dir: at === -1 ? '' : p.slice(0, at + 1), file: at === -1 ? p : p.slice(at + 1) }
}

/** duplicate | pattern + similarity → a status word and a badge tone, like the prototype. */
function statusOf(g: Group): { label: string; tone: 'neutral' | 'warn' | 'bad' } {
  const diverged = g.members.some((m) => m.divergence.length > 0)
  if (diverged) return { label: 'Diverged', tone: 'bad' }
  if (g.similarity >= 0.999) return { label: 'Identical', tone: 'neutral' }
  return { label: g.classification === 'pattern' ? 'Pattern' : 'Near-duplicate', tone: 'warn' }
}

export default function DuplicatesIndex({
  workspace,
  repository,
  commitSha,
  groups,
}: Props): ReactElement {
  const [filter, setFilter] = useState<'All' | 'Diverged' | 'Identical'>('All')
  const [selected, setSelected] = useState<string | null>(groups[0]?.id ?? null)

  const rows = useMemo(
    () =>
      groups.filter((g) => {
        if (filter === 'All') return true
        const s = statusOf(g).label
        return filter === 'Diverged' ? s === 'Diverged' : s === 'Identical'
      }),
    [groups, filter]
  )
  const current = groups.find((g) => g.id === selected) ?? rows[0] ?? null
  const counts = {
    All: groups.length,
    Diverged: groups.filter((g) => statusOf(g).label === 'Diverged').length,
    Identical: groups.filter((g) => statusOf(g).label === 'Identical').length,
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-page="duplicates">
      <Head title={`Duplicates · ${repository.name}`} />
      <PageHeader
        title={
          <>
            <Copy className="h-3.5 w-3.5 text-content-muted" />
            Duplicates
            <span className="font-normal text-content-muted">
              {groups.length} {groups.length === 1 ? 'group' : 'groups'}
            </span>
          </>
        }
      >
        {commitSha ? (
          <span className="inline-flex items-center gap-1 text-xs text-content-muted">
            <GitCommitHorizontal className="h-3.5 w-3.5" />
            <code className="mono">{commitSha.slice(0, 7)}</code>
          </span>
        ) : null}
      </PageHeader>

      {groups.length === 0 ? (
        <p className="p-6 text-content-muted">
          No duplicate or near-duplicate code was found at this commit.
        </p>
      ) : (
        <>
          <div className="flex h-10 flex-none items-center gap-1.5 border-b border-line px-4">
            {(['All', 'Diverged', 'Identical'] as const).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setFilter(c)}
                data-active={filter === c}
                className="inline-flex h-6 items-center rounded-md px-2 text-xs text-content-secondary shadow-[inset_0_0_0_1px_var(--color-border-input)] hover:bg-hover data-[active=true]:bg-active data-[active=true]:text-content-primary"
              >
                {c} {counts[c]}
              </button>
            ))}
          </div>

          <div className="scroll flex-1">
            <table className="view duplicates-table" data-component="duplicates">
              <thead>
                <tr>
                  <th>Function</th>
                  <th>Copies</th>
                  <th data-align="right">Similarity</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((g) => {
                  const status = statusOf(g)
                  const name = g.members[0]?.symbol.split('.').pop() ?? g.members[0]?.symbol ?? '—'
                  const others = g.members
                    .slice(1)
                    .map((m) => shortPath(m.path).dir.replace(/\/$/, ''))
                    .join(' · ')
                  return (
                    <tr
                      key={g.id}
                      data-active={current?.id === g.id}
                      className="cursor-pointer data-[active=true]:bg-hover"
                      onClick={() => setSelected(g.id)}
                    >
                      <td>
                        <code>{name}</code>
                      </td>
                      <td data-tone="muted" className="mono truncate">
                        {others || `${g.members.length} sites`}
                      </td>
                      <td data-align="right">
                        <span className="mono">{Math.round(g.similarity * 100)}%</span>
                      </td>
                      <td>
                        <span
                          className={`badge badge-${status.tone === 'bad' ? 'bad' : status.tone === 'warn' ? 'warn' : 'muted'}`}
                        >
                          {status.label}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {current ? (
              <GroupDetail
                workspaceHandle={workspace.handle}
                repositoryHandle={repository.handle}
                group={current}
              />
            ) : null}
          </div>
        </>
      )}
    </div>
  )
}
