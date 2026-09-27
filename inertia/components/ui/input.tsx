// Vendored from shadcn/ui, restyled on the design tokens.
import * as React from 'react'
import { cn } from '~/lib/utils'

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'field h-[34px] w-full px-3 text-[13px] text-content-primary placeholder:text-content-muted disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
}
