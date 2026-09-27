import { Head } from '@inertiajs/react'
import { CircleCheck, Layers, TriangleAlert } from 'lucide-react'
import { PageHeader } from '../../components/shell/page_header'

interface Check {
  key: string
  label: string
  state: 'on' | 'off'
  detail: string
  invariant: string
}
interface Props {
  workspace: { handle: string; name: string }
  repositoryCount: number
  memberCount: number
  checks: Check[]
  assetsVersion?: string
}

export default function IsolationIndex({ workspace, repositoryCount, memberCount, checks }: Props) {
  const armed = checks.filter((c) => c.state === 'on').length
  return (
    <div className="flex min-w-0 flex-1 flex-col" data-page="isolation">
      <Head title="Isolation checks" />
      <PageHeader
        title={
          <>
            <Layers className="h-3.5 w-3.5 text-content-muted" />
            Isolation checks
            <span className="font-normal text-content-muted">{workspace.name}</span>
          </>
        }
      >
        <span className={`badge badge-${armed === checks.length ? 'ok' : 'warn'}`}>
          {armed === checks.length ? (
            <CircleCheck className="h-3 w-3" />
          ) : (
            <TriangleAlert className="h-3 w-3" />
          )}
          {armed}/{checks.length} in effect
        </span>
      </PageHeader>

      <div className="scroll flex-1">
        <div className="mx-auto max-w-[860px] px-6 py-6">
          <div className="mb-5 grid grid-cols-2 gap-2.5">
            <div className="rounded-[10px] px-4 py-3 outline outline-1 outline-line">
              <div className="text-content-muted">Repositories</div>
              <div className="mono mt-0.5 text-[20px] text-content-primary">{repositoryCount}</div>
            </div>
            <div className="rounded-[10px] px-4 py-3 outline outline-1 outline-line">
              <div className="text-content-muted">Members</div>
              <div className="mono mt-0.5 text-[20px] text-content-primary">{memberCount}</div>
            </div>
          </div>

          <div className="overflow-hidden rounded-[10px] outline outline-1 outline-line">
            {checks.map((c, i) => (
              <div
                key={c.key}
                className={`grid grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-3 px-4 py-3 ${
                  i < checks.length - 1 ? 'border-b border-line' : ''
                }`}
              >
                {c.state === 'on' ? (
                  <CircleCheck className="mt-0.5 h-4 w-4 text-success" />
                ) : (
                  <TriangleAlert className="mt-0.5 h-4 w-4 text-warning" />
                )}
                <div className="min-w-0">
                  <div className="font-medium text-content-primary">{c.label}</div>
                  <p className="m-0 mt-0.5 leading-relaxed text-content-secondary">{c.detail}</p>
                </div>
                <code className="mono flex-none text-xs text-content-muted">{c.invariant}</code>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-content-muted">
            These are the controls in effect, not a live audit. The honeytoken sensor is proven
            end-to-end in the test suite; a lost workspace filter surfaces a foreign token and the
            gateway blocks it with a P1 event.
          </p>
        </div>
      </div>
    </div>
  )
}
