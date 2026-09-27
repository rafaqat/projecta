import { FileCode, Hash, X } from 'lucide-react'
import { Badge } from '~/components/ui/badge'
import { IconButton } from '~/components/ui/button'
import { splitPath } from './sources'

export interface DeclarationView {
  path: string
  qualifiedName: string
  start: number
  end: number
  lines: string[]
}

/**
 * The reading pane for a declaration the answer named but did not cite: its own code,
 * line-numbered from the index's span, read-only, opened from the grey box without spending a model
 * turn. It carries no citation mark or span hash because nothing here was cited — the header says so
 * ("not cited"), and the lines come from the indexed blob (secrets already redacted).
 */
export function DeclarationPane({
  declaration,
  onClose,
}: {
  declaration: DeclarationView
  onClose: () => void
}) {
  const { file } = splitPath(declaration.path)
  return (
    <section
      aria-label={`Declaration preview: ${file}`}
      data-declaration-pane
      className="slide-in flex min-w-[380px] flex-[0_1_540px] flex-col border-l border-line"
    >
      <div className="flex h-11 flex-none items-center gap-1.5 border-b border-line pl-4 pr-2">
        <FileCode className="h-3.5 w-3.5 flex-none text-content-muted" />
        <span className="mono truncate font-medium text-content-primary">{file}</span>
        <Badge>not cited</Badge>
        <div className="flex-1" />
        <IconButton label="Close (Esc)" onClick={onClose} data-close-declaration>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <div className="flex flex-none flex-wrap gap-3.5 border-b border-line px-4 py-2.5 text-xs text-content-muted">
        <span className="flex items-center gap-1">
          <Hash className="h-3 w-3" />
          <span className="mono text-content-secondary">{declaration.qualifiedName}</span>
        </span>
        <span>
          lines {declaration.start}–{declaration.end}
        </span>
        <span>read from the index, not the model</span>
      </div>
      <div className="scroll flex-1">
        <div className="py-2">
          {declaration.lines.map((text, i) => (
            <div key={declaration.start + i} className="code-line" data-hit="false">
              <span>{declaration.start + i}</span>
              <span>{text}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-none items-center gap-1.5 border-t border-line px-4 py-2.5 text-xs text-content-disabled">
        <span className="mono text-content-muted">{declaration.path}</span>
        <div className="flex-1" />
        <span>Esc to close</span>
      </div>
    </section>
  )
}
