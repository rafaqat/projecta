import type { ReactNode } from 'react'

/** The 44px bar at the top of every panel: a title on the left, actions on the right. */
export function PageHeader({ title, children }: { title?: ReactNode; children?: ReactNode }) {
  return (
    // min-w-0 lets the bar shrink inside a flex panel; overflow-x-auto keeps the
    // actions scrollable within the panel at narrow widths instead of spilling
    // over the neighbouring panel's header. Actions stay on one line (shrink-0).
    <div className="flex h-11 min-w-0 flex-none items-center gap-2 overflow-x-auto border-b border-line pl-4 pr-2.5">
      {title ? (
        <div className="flex shrink-0 items-center gap-2 whitespace-nowrap font-medium">
          {title}
        </div>
      ) : null}
      <div className="min-w-[8px] flex-1" />
      <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">{children}</div>
    </div>
  )
}
