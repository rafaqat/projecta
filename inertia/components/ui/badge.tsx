// Vendored from shadcn/ui; the `.badge*` classes are the ones tests select on.
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '~/lib/utils'

export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'ai' | 'muted'

export function Badge({
  tone = 'neutral',
  icon: Icon,
  className,
  children,
  ...rest
}: {
  tone?: BadgeTone
  icon?: LucideIcon
  className?: string
  children: ReactNode
} & Record<`data-${string}`, string | undefined>) {
  return (
    <span className={cn('badge', tone !== 'neutral' && `badge-${tone}`, className)} {...rest}>
      {Icon ? <Icon className="h-3 w-3" /> : null}
      {children}
    </span>
  )
}
