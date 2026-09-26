// Vendored from shadcn/ui: a Radix dialog that slides in from the right.
import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '~/lib/utils'

export const Sheet = DialogPrimitive.Root
export const SheetTrigger = DialogPrimitive.Trigger
export const SheetClose = DialogPrimitive.Close
export const SheetTitle = DialogPrimitive.Title
export const SheetDescription = DialogPrimitive.Description

export function SheetContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-page/60 data-[state=open]:fade-in" />
      <DialogPrimitive.Content
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex w-[560px] max-w-[92vw] flex-col border-l border-line bg-card text-content-primary outline-none data-[state=open]:slide-in',
          className
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          className="ghost absolute right-3 top-3 grid h-7 w-7 place-items-center"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('border-b border-line px-5 py-4 text-left', className)} {...props} />
}
