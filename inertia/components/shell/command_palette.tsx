import { Fragment, useState } from 'react'
import { Search } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog'
import type { Command } from '~/lib/navigation'

/** Cmd/Ctrl+K: filter, arrow keys, Enter runs, Escape closes (Radix). */
export function CommandPalette({
  open,
  onOpenChange,
  commands,
  onRun,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  commands: Command[]
  onRun: (command: Command) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-command-palette>
        <DialogTitle className="sr-only">Command menu</DialogTitle>
        <DialogDescription className="sr-only">Search pages and actions</DialogDescription>
        {/* Mounted only while open, so the query resets on every opening. */}
        <PaletteBody commands={commands} onRun={onRun} />
      </DialogContent>
    </Dialog>
  )
}

function PaletteBody({
  commands,
  onRun,
}: {
  commands: Command[]
  onRun: (command: Command) => void
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const items = commands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, items.length - 1))
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    }
    if (e.key === 'Enter' && items[selected]) {
      e.preventDefault()
      onRun(items[selected])
    }
  }
  return (
    <>
      <div className="flex h-12 items-center gap-2.5 border-b border-line px-4">
        <Search className="h-4 w-4 text-content-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSelected(0)
          }}
          onKeyDown={onKey}
          placeholder="Type a command or search…"
          aria-label="Search commands"
          className="flex-1 border-0 bg-transparent text-[15px] text-content-primary outline-none placeholder:text-content-muted"
        />
      </div>
      <div className="scroll max-h-[360px] p-1.5" role="listbox">
        {items.length === 0 ? (
          <div className="px-2.5 py-3 text-xs text-content-muted">No results.</div>
        ) : null}
        {items.map((command, i) => (
          <Fragment key={`${command.group}-${command.label}`}>
            {i === 0 || items[i - 1].group !== command.group ? (
              <div className="px-2.5 pb-1 pt-2 text-[11.5px] text-content-muted">
                {command.group}
              </div>
            ) : null}
            <button
              type="button"
              role="option"
              aria-selected={i === selected}
              onMouseMove={() => setSelected(i)}
              onClick={() => onRun(command)}
              className={`flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left ${i === selected ? 'bg-active' : ''}`}
            >
              <command.icon
                className={`h-4 w-4 ${i === selected ? 'text-content-primary' : 'text-content-muted'}`}
              />
              <span className="flex-1">{command.label}</span>
              {command.kbd ? <span className="kbd">{command.kbd}</span> : null}
            </button>
          </Fragment>
        ))}
      </div>
      <div className="flex gap-3.5 border-t border-line px-3.5 py-2 text-[11.5px] text-content-muted">
        <span>↑↓ to move</span>
        <span>↵ to open</span>
        <span>esc to close</span>
      </div>
    </>
  )
}
