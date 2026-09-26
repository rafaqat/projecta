// Vendored from shadcn/ui, restyled on the design tokens.
import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cn } from '~/lib/utils'

export const Tabs = TabsPrimitive.Root
export const TabsContent = TabsPrimitive.Content

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('inline-flex h-7 items-center gap-0.5 rounded-lg bg-hover p-0.5', className)}
      {...props}
    />
  )
}

export function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-md px-2.5 text-xs text-content-secondary outline-none data-[state=active]:bg-card data-[state=active]:text-content-primary data-[state=active]:shadow-[0_0_0_1px_var(--color-border-input)]',
        className
      )}
      {...props}
    />
  )
}
