import { useEffect, useState } from 'react'
import { FileCode } from 'lucide-react'
import { sha256Hex } from '../../lib/answer_stream'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '~/components/ui/hover_card'
import { splitPath, type Citation } from './sources'

/**
 * A citation is a numbered chip in the answer. Hovering previews the cited
 * span; clicking opens it beside the answer. The span hash is recomputed in
 * the browser from the hydrated snippet and compared with the server's
 *, and the result is exposed on `data-verified`.
 */
export function CitationCard({
  citation,
  n,
  active,
  onOpen,
}: {
  citation: Citation
  n: number
  active: boolean
  onOpen: (handle: string) => void
}) {
  const [verified, setVerified] = useState<boolean | null>(null)
  useEffect(() => {
    sha256Hex(citation.snippet).then((hash) => setVerified(hash === citation.spanSha256))
  }, [citation.snippet, citation.spanSha256])
  const { dir, file } = splitPath(citation.symbol.path)
  const state = verified === null ? 'pending' : String(verified)
  return (
    <HoverCard openDelay={250} closeDelay={60}>
      <HoverCardTrigger asChild>
        <span
          role="button"
          tabIndex={0}
          className="citation"
          data-active={active}
          data-handle={citation.handle}
          data-verified={state}
          aria-label={`Open source ${n}`}
          onClick={() => onOpen(citation.handle)}
          onKeyDown={(e) => e.key === 'Enter' && onOpen(citation.handle)}
        >
          {n}
        </span>
      </HoverCardTrigger>
      <HoverCardContent>
        <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
          <FileCode className="h-3 w-3 text-content-muted" />
          <span className="mono text-content-primary">
            <span className="text-content-muted">{dir}</span>
            {file}
          </span>
          <span className="flex-1" />
          <span className="text-xs text-content-muted">
            L{citation.span.start}–{citation.span.end}
          </span>
        </div>
        <pre className="snippet m-0 max-h-[220px] overflow-auto rounded-none bg-transparent px-3 py-2 text-content-secondary shadow-none">
          <code>{citation.snippet}</code>
        </pre>
        <div className="flex items-center gap-2 border-t border-line px-3 py-1.5 text-xs text-content-muted">
          <span
            className={`badge badge-${verified ? 'ok' : verified === false ? 'bad' : 'pending'}`}
          >
            {verified === null ? 'checking hash' : verified ? 'hash verified' : 'hash mismatch'}
          </span>
          <span>Click to open beside the answer</span>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
