import { Head } from '@inertiajs/react'
import { Link } from '@adonisjs/inertia/react'
import { Building2, ChevronRight } from 'lucide-react'
import { PageHeader } from '~/components/shell/page_header'

interface Props {
  workspaces: Array<{ handle: string; name: string }>
}

export default function WorkspacesIndex({ workspaces }: Props) {
  return (
    <>
      <Head title="Workspaces" />
      <PageHeader title="Your workspaces" />
      <div className="scroll flex-1 p-3">
        {workspaces.length === 0 ? (
          <p className="px-2 py-6 text-content-muted">You are not a member of any workspace yet.</p>
        ) : null}
        <ul className="grid gap-1">
          {workspaces.map((w) => (
            <li key={w.handle}>
              <Link
                href={`/w/${w.handle}`}
                className="nav-item flex h-10 items-center gap-3 px-3 text-content-primary"
              >
                <span className="mark grid h-6 w-6 flex-none place-items-center rounded-md text-[11px] font-semibold">
                  {w.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="flex-1 truncate font-medium">{w.name}</span>
                <Building2 className="h-3.5 w-3.5" />
                <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
