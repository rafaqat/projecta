import { type Data } from '@generated/data'
import { usePage } from '@inertiajs/react'
import { type ReactElement } from 'react'
import { AppShell } from '~/components/shell/app_shell'
import type { PageContext } from '~/lib/navigation'

/**
 * Signed-in pages render inside the shell; the front door and the auth
 * pages render bare. The shell's navigation is derived from the page's own
 * props, so no presenter grows for it (AC-WP16-04).
 */
export default function Layout({ children }: { children: ReactElement<Data.SharedProps> }) {
  const { component, url, flash } = usePage()
  const user = children.props.user
  const notices = (
    <>
      {flash.error ? (
        <p role="alert" className="mx-4 mt-2 rounded-md bg-danger-wash px-3 py-2 text-danger">
          {flash.error}
        </p>
      ) : null}
      {flash.success ? (
        <p role="status" className="mx-4 mt-2 rounded-md bg-success-wash px-3 py-2 text-success">
          {flash.success}
        </p>
      ) : null}
    </>
  )

  if (!user) {
    return (
      <main className="flex min-h-full flex-col">
        {notices}
        {children}
      </main>
    )
  }

  const page = { component, url, ...(children.props as Partial<PageContext>) }
  return (
    <AppShell page={page} user={user}>
      {notices}
      {children}
    </AppShell>
  )
}
