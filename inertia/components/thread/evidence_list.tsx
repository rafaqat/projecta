import { Check, Hash, ScanSearch } from 'lucide-react'
import { Badge } from '~/components/ui/badge'
import { splitPath, type Source } from './sources'

/**
 * The evidence rail: every cited span in the thread, numbered as in the
 * answer, plus the status labels the run emitted ("how this was found").
 */
export function EvidenceList({
  sources,
  trail,
  active,
  onOpen,
}: {
  sources: Source[]
  trail: string[]
  active: string | null
  onOpen: (key: string | null) => void
}) {
  const compact = active !== null
  return (
    <aside
      aria-label="Evidence"
      data-evidence-list
      className={`flex flex-none flex-col border-l border-line transition-[width] ${compact ? 'w-[248px]' : 'w-[340px]'}`}
    >
      <div className="flex h-11 flex-none items-center gap-2 border-b border-line pl-4 pr-3">
        <span className="font-medium">Evidence</span>
        {sources.length ? (
          <Badge tone="ok" icon={Check}>
            {sources.length} cited
          </Badge>
        ) : null}
      </div>
      <div className="scroll flex-1">
        <div className="p-2" role="listbox" aria-label="Sources">
          {sources.length === 0 ? (
            <p className="px-2 py-3 text-xs text-content-muted">
              Sources appear here as the answer cites them.
            </p>
          ) : null}
          {sources.map(({ n, key, citation }) => {
            const on = active === key
            const { dir, file } = splitPath(citation.symbol.path)
            return (
              <button
                key={key}
                type="button"
                role="option"
                aria-selected={on}
                data-active={on}
                data-source={key}
                onClick={() => onOpen(on ? null : key)}
                className="source-row fade-in grid w-full grid-cols-[20px_minmax(0,1fr)] gap-2.5 p-2 text-left"
              >
                <span className="source-n grid h-5 place-items-center rounded-md text-[10.5px] font-semibold">
                  {n}
                </span>
                <span className="min-w-0">
                  <span className="mono block truncate">
                    <span className="text-content-muted">{compact ? '' : dir}</span>
                    <span className="text-content-primary">{file}</span>
                  </span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-content-muted">
                    <Hash className="h-3 w-3 flex-none" />
                    <span className="truncate">{citation.symbol.qualifiedName}</span>
                    <span>·</span>
                    <span className="flex-none">
                      L{citation.span.start}–{citation.span.end}
                    </span>
                  </span>
                </span>
              </button>
            )
          })}
        </div>
        {trail.length ? (
          <>
            <div className="flex items-center gap-1.5 px-4 pb-1.5 pt-3 text-xs font-medium text-content-muted">
              <ScanSearch className="h-3 w-3" />
              How this was found
            </div>
            <ul className="timeline m-0 list-none px-4 pb-4">
              {trail.map((label, i) => (
                <li
                  key={i}
                  className="grid grid-cols-[18px_minmax(0,1fr)] items-start gap-2.5 py-1.5 text-[12.5px] text-content-secondary"
                >
                  <span className="mt-1 grid h-4 w-4 place-items-center">
                    <span className="h-1.5 w-1.5 rounded-full bg-content-muted" />
                  </span>
                  <span className="min-w-0">{label}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </aside>
  )
}
