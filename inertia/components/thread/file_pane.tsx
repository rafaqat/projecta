import { ChevronDown, ChevronUp, FileCode, Hash, X } from 'lucide-react'
import { Badge } from '~/components/ui/badge'
import { IconButton } from '~/components/ui/button'
import { splitPath, type Source } from './sources'

/**
 * The reading pane: the cited span, line-numbered from the server's range,
 * with the identifiers that pin it (commit, blob, span hash). J/K move
 * between sources, Escape closes; the keys are handled by the thread.
 */
export function FilePane({
  source,
  sources,
  onOpen,
}: {
  source: Source
  sources: Source[]
  onOpen: (key: string | null) => void
}) {
  const { citation, n } = source
  const idx = sources.findIndex((s) => s.key === source.key)
  const { file } = splitPath(citation.symbol.path)
  // The cited lines, inside the declaration around them when the server sent it (WP-28): a
  // citation of a signature alone is exact and truthful, and alone it reads as cut off. Context
  // is unmarked and dimmed — it was not cited, and the span hash above does not cover it.
  const cited = citation.snippet.split('\n')
  const context = citation.context
  const shown = context
    ? context.lines.map((text, i) => {
        const number = context.start + i
        return { number, text, hit: number >= citation.span.start && number <= citation.span.end }
      })
    : cited.map((text, i) => ({ number: citation.span.start + i, text, hit: true }))
  const citedLabel =
    citation.span.start === citation.span.end
      ? `cited line ${citation.span.start}`
      : `cited lines ${citation.span.start}–${citation.span.end}`
  return (
    <section
      aria-label={`File preview: ${file}`}
      data-file-pane
      className="slide-in flex min-w-[380px] flex-[0_1_540px] flex-col border-l border-line"
    >
      <div className="flex h-11 flex-none items-center gap-1.5 border-b border-line pl-4 pr-2">
        <FileCode className="h-3.5 w-3.5 flex-none text-content-muted" />
        <span className="mono truncate font-medium text-content-primary">{file}</span>
        <Badge tone="info">Source {n}</Badge>
        <div className="flex-1" />
        <span className="mr-1 whitespace-nowrap text-xs text-content-muted">
          {idx + 1} of {sources.length}
        </span>
        <IconButton
          label="Previous source (K)"
          disabled={idx <= 0}
          onClick={() => onOpen(sources[idx - 1].key)}
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          label="Next source (J)"
          disabled={idx >= sources.length - 1}
          onClick={() => onOpen(sources[idx + 1].key)}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton label="Close (Esc)" onClick={() => onOpen(null)} data-close-file>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <div className="flex flex-none flex-wrap gap-3.5 border-b border-line px-4 py-2.5 text-xs text-content-muted">
        <span className="flex items-center gap-1">
          <Hash className="h-3 w-3" />
          <span className="mono text-content-secondary">{citation.symbol.qualifiedName}</span>
        </span>
        <span>
          commit{' '}
          <span className="mono text-content-secondary">{citation.commitSha.slice(0, 7)}</span>
        </span>
        <span>
          blob <span className="mono text-content-secondary">{citation.blobSha.slice(0, 7)}</span>
        </span>
        <span>
          sha256{' '}
          <span className="mono text-content-secondary">{citation.spanSha256.slice(0, 12)}</span>
        </span>
        <span>{citation.precision === 'span' ? 'exact span' : 'whole symbol'}</span>
        {context ? (
          <span data-cited-lines>
            {citedLabel} of {context.start}–{context.start + context.lines.length - 1}
          </span>
        ) : null}
      </div>
      <div className="scroll flex-1">
        <div className="py-2">
          {shown.map((line) => (
            <div key={line.number} className="code-line" data-hit={line.hit ? 'true' : 'false'}>
              <span>{line.number}</span>
              <span>{line.text}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-none items-center gap-1.5 border-t border-line px-4 py-2.5 text-xs text-content-disabled">
        <span className="mono text-content-muted">{citation.symbol.path}</span>
        <div className="flex-1" />
        <span>J / K to move · Esc to close</span>
      </div>
    </section>
  )
}
