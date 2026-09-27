import { Fragment } from 'react'
import { ChevronRight } from 'lucide-react'
import { Link } from '@adonisjs/inertia/react'
import type { Crumb } from '~/lib/navigation'

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap text-content-muted"
    >
      {items.map((crumb, i) => {
        const last = i === items.length - 1
        const inner = (
          <>
            {crumb.icon ? <crumb.icon className="h-3.5 w-3.5 flex-none" /> : null}
            <span className="max-w-[420px] truncate">{crumb.label}</span>
          </>
        )
        return (
          <Fragment key={`${crumb.label}-${i}`}>
            {i > 0 ? <ChevronRight className="h-3 w-3 flex-none text-content-disabled" /> : null}
            {crumb.href ? (
              <Link
                href={crumb.href}
                className="crumb flex h-6 min-w-0 items-center gap-1.5 px-1.5"
              >
                {inner}
              </Link>
            ) : (
              <span
                aria-current={last ? 'page' : undefined}
                className={`flex h-6 min-w-0 items-center gap-1.5 px-1.5 ${last ? 'font-medium text-content-primary' : ''}`}
              >
                {inner}
              </span>
            )}
          </Fragment>
        )
      })}
    </nav>
  )
}
