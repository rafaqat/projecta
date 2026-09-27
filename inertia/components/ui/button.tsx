// Vendored from shadcn/ui, restyled on the design tokens.
import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '~/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[7px] text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-35 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-raised text-content-primary shadow-[inset_0_0_0_1px_var(--color-border-input)] hover:bg-hover',
        primary: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        ghost: 'text-content-secondary hover:bg-hover hover:text-content-primary',
        outline:
          'text-content-secondary shadow-[inset_0_0_0_1px_var(--color-border-input)] hover:bg-hover hover:text-content-primary',
      },
      size: {
        default: 'h-7 px-2.5',
        sm: 'h-6 px-2 text-xs',
        icon: 'h-7 w-7',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      type={asChild ? undefined : 'button'}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

/** An icon-only button with its accessible name. */
export function IconButton({
  label,
  className,
  children,
  ...props
}: Omit<ButtonProps, 'size' | 'variant'> & { label: string }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      className={cn('grid place-items-center', className)}
      {...props}
    >
      {children}
    </Button>
  )
}
