import { Head, usePage } from '@inertiajs/react'
import type { Data } from '@generated/data'
import { Thread } from '../../components/thread/thread'
import {
  IngestActions,
  IngestPanel,
  useIngest,
  type IngestView,
} from '../../components/repositories/ingest_panel'

interface Props {
  workspace: { handle: string; name: string }
  repository: { handle: string; name: string; url: string; visibility: string }
  ingest: IngestView
  canManage: boolean
  /** The build this page rendered with; the thread reloads when a turn answers from a newer one. */
  assetsVersion?: string
}

/**
 * Until the repository has an active commit the page is the indexing view:
 * queued, the steps of the current run, or the failure and its reason. Once
 * indexed it is the thread, with the run's state polled only while a job is
 * queued so a re-index shows its progress in place.
 */
export default function RepositoryShow({
  workspace,
  repository,
  ingest,
  canManage,
  assetsVersion,
}: Props) {
  const { user } = usePage<Data.SharedProps>().props
  const base = `/api/w/${workspace.handle}/r/${repository.handle}`
  const [view, refresh] = useIngest(base, ingest)
  const actions = canManage ? (
    <IngestActions
      workspace={workspace.handle}
      base={base}
      repositoryName={repository.name}
      view={view}
      onQueued={refresh}
    />
  ) : undefined
  const ready = view.activeCommit !== null && !view.queued && view.status !== 'indexing'
  // From inside an answer: the commit is already indexed, so the re-index forces re-derivation.
  const reindex = canManage
    ? async () => {
        const token = /XSRF-TOKEN=([^;]+)/.exec(document.cookie)
        const response = await fetch(`${base}/ingest`, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'X-XSRF-TOKEN': token ? decodeURIComponent(token[1]) : '',
          },
          body: JSON.stringify({ force: true }),
        })
        if (response.status !== 202 && response.status !== 409)
          throw new Error(`re-index refused (${response.status})`)
        refresh()
      }
    : undefined
  return (
    <>
      <Head title={repository.name} />
      {ready ? (
        <Thread
          workspace={workspace.handle}
          repository={repository.handle}
          repositoryName={repository.name}
          user={user ?? { fullName: null, initials: '·' }}
          actions={actions}
          onReindex={reindex}
          assetsVersion={assetsVersion}
        />
      ) : (
        <IngestPanel view={view} repositoryName={repository.name} actions={actions} />
      )}
    </>
  )
}
