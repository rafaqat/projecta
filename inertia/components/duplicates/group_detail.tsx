import { Copy, FileCode, MessageSquareText, TriangleAlert } from 'lucide-react'

export interface CloneMember {
  path: string
  symbol: string
  startLine: number
  endLine: number
  tokens: number
  divergence: Array<{ start: number; end: number }>
}
export interface CloneGroup {
  id: string
  classification: string
  method: string
  similarity: number
  size: number
  members: CloneMember[]
}

const shortPath = (p: string) => {
  const at = p.lastIndexOf('/')
  return { dir: at === -1 ? '' : p.slice(0, at + 1), file: at === -1 ? p : p.slice(at + 1) }
}

/** The selected clone group: the two members side by side, and the divergence note. */
export function GroupDetail({
  workspaceHandle,
  repositoryHandle,
  group,
}: {
  workspaceHandle: string
  repositoryHandle: string
  group: CloneGroup
}) {
  const a = group.members[0]
  const b = group.members[1]
  const diverged = group.members.some((m) => m.divergence.length > 0)
  const ask = `/w/${workspaceHandle}/r/${repositoryHandle}?q=${encodeURIComponent(
    `What is duplicated between ${a?.symbol ?? ''} and ${b?.symbol ?? ''}, and where do they diverge?`
  )}`
  const members = [a, b].filter((m): m is CloneMember => Boolean(m))
  return (
    <div className="m-4 mt-5 grid grid-cols-1 overflow-hidden rounded-[10px] outline outline-1 outline-line md:grid-cols-2">
      {members.map((m, i) => {
        const { dir, file } = shortPath(m.path)
        return (
          <div key={i} className={i === 1 ? 'border-t border-line md:border-l md:border-t-0' : ''}>
            <div className="mono flex h-9 items-center gap-2 border-b border-line bg-input px-3 text-content-secondary">
              <FileCode className="h-3 w-3" />
              <span>
                <span className="text-content-muted">{dir}</span>
                {file}
              </span>
              <span className="flex-1" />
              <span className="text-xs text-content-muted">
                L{m.startLine}–{m.endLine}
              </span>
            </div>
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2 text-xs text-content-muted">
              <span>Symbol</span>
              <code className="mono text-content-secondary">{m.symbol}</code>
              <span>Tokens</span>
              <span className="mono">{m.tokens}</span>
              <span>Diverges</span>
              <span className="mono">
                {m.divergence.length
                  ? m.divergence.map((d) => `${d.start}–${d.end}`).join(', ')
                  : 'no'}
              </span>
            </div>
          </div>
        )
      })}
      <div className="col-span-full flex items-start gap-3 border-t border-line bg-input px-3.5 py-3">
        <span className={`badge badge-${diverged ? 'bad' : 'muted'}`}>
          {diverged ? <TriangleAlert className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {diverged ? 'Divergence' : `${Math.round(group.similarity * 100)}% similar`}
        </span>
        <p className="m-0 flex-1 leading-relaxed text-content-secondary">
          {diverged ? (
            <>
              <span className="font-semibold text-content-primary">
                These copies have drifted apart.
              </span>{' '}
              One member changed on lines the other did not — a fix or bug in one may not be in the
              other. Ask about it to see the exact difference from the code.
            </>
          ) : (
            <>
              {group.members.length} copies of this code at {Math.round(group.similarity * 100)}%
              similarity, matched by {group.method}. Ask about it to see what each site does.
            </>
          )}
        </p>
        <a
          href={ask}
          className="inline-flex h-7 flex-none items-center gap-1.5 rounded-md bg-raised px-2.5 text-[13px] font-medium text-content-primary shadow-[inset_0_0_0_1px_var(--color-border-input)] hover:bg-hover"
        >
          <MessageSquareText className="h-3.5 w-3.5" />
          Ask about this
        </a>
      </div>
    </div>
  )
}
