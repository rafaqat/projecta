import { useEffect, useRef, useState, type ReactNode } from 'react'
import { router } from '@inertiajs/react'
import {
  AlertTriangle,
  Check,
  EyeOff,
  GitCommitHorizontal,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { Badge, type BadgeTone } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog'

export type IngestView = {
  status: string
  statusDetail: string | null
  defaultRef: string
  queued: boolean
  jobState: string | null
  retryCount: number
  /** Jobs ahead and what the worker is on; null when nothing of this repository's waits. */
  queue: {
    ahead: number
    active: { repositoryId: string | null; name: string | null } | null
  } | null
  /** What the detector read in each flagged chunk of the active commit, at most 50. */
  flaggedChunks?: Array<{
    chunkId: string
    path: string
    start: number
    end: number
    window: number | null
    text: string
  }>
  activeCommit: { sha: string; indexedAt: string | null } | null
  steps: Array<{
    step: string
    status: string
    startedAt: string | null
    finishedAt: string | null
    progress: StepProgress | null
  }>
  /** The commit's files in the order the indexer walks them, while an index is pending. */
  files: Array<{
    path: string
    change: string
    skipReason: string | null
    ignoredBy: string | null
  }> | null
  /** The ignore list in force; null in page props when it is the default one (the status carries it). */
  ignorePaths: string[] | null
  ignoreIsDefault: boolean
}

export type StepProgress = {
  phase: string
  done: number
  total: number
  path?: string
  counts?: {
    filesParsed: number
    filesCopied: number
    filesSkipped: Record<string, number>
    symbols: number
    chunks: number
    embeddingsComputed: number
    embeddingsCached: number
    flagged: number
    flaggedSpans?: Array<{ path: string; start: number; end: number }>
    endpoints: number
    dependencies: number
    cloneClasses: number
  }
}

const SKIP_REASONS: Record<string, string> = {
  unsupported_language: 'no grammar',
  symlink: 'symlink',
  no_content: 'no content',
  binary: 'binary',
}

/** Rate from the step's start, and what remains at that rate. */
function pace(startedAt: string | null, done: number, total: number): string {
  if (!startedAt || done < 2) return ''
  const elapsed = (Date.now() - new Date(startedAt).getTime()) / 1000
  if (elapsed <= 0) return ''
  const rate = done / elapsed
  const left = Math.max(0, total - done) / rate
  const eta = left < 60 ? `${Math.ceil(left)}s` : `${Math.ceil(left / 60)} min`
  return `${rate.toFixed(1)} files/s · about ${eta} left`
}

const PHASES: Record<string, string> = {
  files: 'files parsed, chunked and embedded',
  extract: 'extracting endpoints and dependencies',
  clones: 'detecting clones',
}

const STEPS: Array<{ name: string; label: string }> = [
  { name: 'resolve', label: 'Resolve the commit' },
  { name: 'read_tree', label: 'Read the tree' },
  { name: 'cochange', label: 'Read change history' },
  { name: 'index', label: 'Parse, chunk and embed' },
  { name: 'activate', label: 'Activate the commit' },
]

/**
 * Polls while a run can still change the page (queued, indexing, or not yet
 * run); stops once indexed or failed and idle. `refresh` fetches at once, for
 * the moment after an action was accepted.
 */
export function useIngest(base: string, initial: IngestView): [IngestView, () => void] {
  const [view, setView] = useState(initial)
  const load = async () => {
    try {
      const response = await fetch(`${base}/ingest`, { headers: { Accept: 'application/json' } })
      if (response.ok) setView((await response.json()) as IngestView)
    } catch {
      // A missed poll is retried on the next tick; the page keeps its last view.
    }
  }
  const live = view.queued || view.status === 'indexing' || view.status === 'registered'
  useEffect(() => {
    if (!live) return
    const timer = setInterval(load, 2500)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, live])
  return [view, () => void load()]
}

function xsrf(): string {
  const m = /XSRF-TOKEN=([^;]+)/.exec(document.cookie)
  return m ? decodeURIComponent(m[1]) : ''
}

function phase(view: IngestView): { label: string; tone: BadgeTone } {
  if (view.jobState === 'active' || view.status === 'indexing')
    return { label: 'indexing', tone: 'info' }
  if (view.queued)
    return { label: view.retryCount ? `retrying (${view.retryCount})` : 'queued', tone: 'info' }
  if (view.status === 'indexed') return { label: 'indexed', tone: 'ok' }
  if (view.status === 'failed') return { label: 'failed', tone: 'bad' }
  return { label: view.status, tone: 'muted' }
}

function seconds(a: string | null, b: string | null): string {
  if (!a || !b) return ''
  return `${((new Date(b).getTime() - new Date(a).getTime()) / 1000).toFixed(1)}s`
}

export function IngestActions({
  workspace,
  base,
  repositoryName,
  view,
  onQueued,
}: {
  workspace: string
  base: string
  repositoryName: string
  view: IngestView
  onQueued: () => void
}) {
  const [busy, setBusy] = useState<'reindex' | 'delete' | 'ignore' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const call = async (method: 'POST' | 'DELETE' | 'PATCH', path: string, body?: unknown) =>
    fetch(path, {
      method,
      headers: {
        'Accept': 'application/json',
        'X-XSRF-TOKEN': xsrf(),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const reindex = async (force = false) => {
    setBusy('reindex')
    setError(null)
    try {
      const response = await call('POST', `${base}/ingest`, force ? { force: true } : undefined)
      if (response.status === 202 || response.status === 409) onQueued()
      else setError(`re-index refused (${response.status})`)
    } finally {
      setBusy(null)
    }
  }
  const destroy = async () => {
    setBusy('delete')
    setError(null)
    const response = await call('DELETE', `/w/${workspace}/r/${base.split('/').at(-1)}`)
    if (response.status === 204) router.visit(`/w/${workspace}`)
    else {
      setError(`delete refused (${response.status})`)
      setBusy(null)
    }
  }
  return (
    <span className="inline-flex items-center gap-1" data-ingest-actions>
      {error ? <span className="text-[12px] text-danger">{error}</span> : null}
      <Button
        variant="outline"
        size="sm"
        onClick={() => reindex(false)}
        disabled={busy !== null}
        title="Fetch and index the default branch again"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${busy === 'reindex' ? 'animate-spin' : ''}`} />
        Re-index
      </Button>
      {view.flaggedChunks && view.flaggedChunks.length > 0 ? (
        <FlaggedChunks chunks={view.flaggedChunks} />
      ) : null}
      <IgnoreRules
        base={base}
        view={view}
        busy={busy !== null}
        onSaved={(reindexNow) => {
          if (reindexNow) void reindex(true)
          else onQueued()
        }}
        onError={setError}
      />
      <Dialog>
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            title="Delete the repository and its index"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Delete {repositoryName}?</DialogTitle>
          <DialogDescription>
            Removes the repository from this workspace with everything indexed for it: commits,
            files, chunks and symbols. Threads about it are removed too. The audit trail is kept.
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="primary"
              size="sm"
              onClick={destroy}
              disabled={busy === 'delete'}
              data-confirm-delete
            >
              {busy === 'delete' ? 'Deleting…' : 'Delete repository'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </span>
  )
}

/** The whole-page view while the index is not ready: status, the steps of the current run, and the last failure. */
export function IngestPanel({
  view,
  repositoryName,
  actions,
}: {
  view: IngestView
  repositoryName: string
  actions?: ReactNode
}) {
  const current = phase(view)
  const byName = new Map(view.steps.map((s) => [s.step, s]))
  return (
    <div
      className="flex flex-1 items-start justify-center p-6"
      data-ingest-panel
      data-ingest-status={current.label}
    >
      <div className="w-full max-w-[560px]">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[15px] font-medium text-content-primary">{repositoryName}</h2>
          <Badge tone={current.tone}>{current.label}</Badge>
        </div>
        <p className="mt-1 text-[12.5px] text-content-muted">
          Branch <span className="mono">{view.defaultRef}</span>
          {view.activeCommit ? (
            <>
              {' · '}indexed at <span className="mono">{view.activeCommit.sha.slice(0, 7)}</span>
            </>
          ) : null}
        </p>

        {view.status === 'failed' && !view.queued ? (
          <div
            role="alert"
            className="mt-4 flex gap-2 rounded-md bg-danger-wash p-3 text-[13px] text-content-primary"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            <div>
              <div className="font-medium">The last run failed</div>
              <pre className="mono mt-1 whitespace-pre-wrap text-[12px] text-content-secondary">
                {view.statusDetail}
              </pre>
            </div>
          </div>
        ) : null}

        <ol className="mt-4 grid gap-1.5" aria-label="Indexing steps">
          {STEPS.map(({ name, label }) => {
            const step = byName.get(name)
            const running = step?.status === 'running'
            const done = step?.status === 'done'
            return (
              <li
                key={name}
                data-step={name}
                data-step-status={step?.status ?? 'pending'}
                className={`flex items-center gap-2 text-[13px] ${done || running ? 'text-content-primary' : 'text-content-muted'}`}
              >
                {done ? (
                  <Check className="h-4 w-4 text-success" />
                ) : running ? (
                  <Loader2 className="h-4 w-4 animate-spin text-content-secondary" />
                ) : (
                  <span className="inline-block h-4 w-4 text-center leading-4">·</span>
                )}
                <span className="flex-1">
                  {label}
                  {running && step?.progress ? (
                    <span className="mt-1 block" data-step-progress>
                      <span className="block h-1 w-full overflow-hidden rounded bg-hover">
                        <span
                          className="block h-full bg-primary transition-[width] duration-300"
                          style={{
                            width: `${step.progress.total ? Math.round((100 * step.progress.done) / step.progress.total) : 0}%`,
                          }}
                        />
                      </span>
                      <span className="mt-0.5 block text-[11.5px] text-content-muted">
                        {step.progress.phase === 'files'
                          ? `${step.progress.done} of ${step.progress.total} ${PHASES.files}`
                          : (PHASES[step.progress.phase] ?? step.progress.phase)}
                      </span>
                      {step.progress.path ? (
                        <span
                          className="mono block truncate text-[11.5px] text-content-secondary"
                          data-step-file
                        >
                          {step.progress.path}
                        </span>
                      ) : null}
                      {step.progress.phase === 'files' ? (
                        <span className="block text-[11.5px] text-content-muted">
                          {pace(step.startedAt, step.progress.done, step.progress.total)}
                        </span>
                      ) : null}
                      {step.progress.counts ? <Counts counts={step.progress.counts} /> : null}
                    </span>
                  ) : null}
                </span>
                <span className="mono text-[11.5px] text-content-muted">
                  {seconds(step?.startedAt ?? null, step?.finishedAt ?? null)}
                </span>
              </li>
            )
          })}
        </ol>
        {view.files && view.files.length ? <FileList view={view} /> : null}
        {view.queued && view.jobState !== 'active' ? (
          <p
            className="mt-3 flex items-center gap-2 text-[12.5px] text-content-muted"
            data-ingest-ahead={view.queue?.ahead ?? 0}
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for the worker
            {view.queue ? (
              <>
                {' · '}
                {view.queue.ahead === 0 ? 'next' : `${view.queue.ahead} ahead`}
                {view.queue.active
                  ? ` · indexing ${view.queue.active.name ?? 'another repository'}`
                  : ''}
              </>
            ) : null}
          </p>
        ) : null}
        {actions ? <div className="mt-5 flex items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  )
}

/**
 * The ignore list for the repository: one gitignore-style pattern per line,
 * the defaults prefilled. Saving applies on the next run; "Save and re-index"
 * re-derives the current commit under the new list; "Reset" restores the
 * defaults.
 */
function IgnoreRules({
  base,
  view,
  busy,
  onSaved,
  onError,
}: {
  base: string
  view: IngestView
  busy: boolean
  onSaved: (reindexNow: boolean) => void
  onError: (message: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const repositoryPath = `/w/${base.split('/')[3]}/r/${base.split('/').at(-1)}`
  // The textarea starts from the list in force each time the dialog opens; page props carry
  // the list only when it is custom, so the defaults come from the status endpoint.
  const onOpenChange = async (next: boolean) => {
    setOpen(next)
    if (!next) return
    let list = view.ignorePaths
    if (!list) {
      const response = await fetch(`${base}/ingest`, { headers: { Accept: 'application/json' } })
      list = response.ok ? ((await response.json()) as IngestView).ignorePaths : []
    }
    setText((list ?? []).join('\n'))
  }
  const save = async (body: { ignorePaths: string | null }, reindexNow: boolean) => {
    setSaving(true)
    setProblem(null)
    try {
      const response = await fetch(repositoryPath, {
        method: 'PATCH',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-XSRF-TOKEN': xsrf(),
        },
        body: JSON.stringify(body),
      })
      if (response.status === 200) {
        setOpen(false)
        onError(null)
        onSaved(reindexNow)
        return
      }
      const payload = (await response.json().catch(() => ({}))) as {
        errors?: Array<{ message: string }>
      }
      setProblem(payload.errors?.[0]?.message ?? `saving refused (${response.status})`)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={busy} title="Paths never read or indexed">
          <EyeOff className="h-3.5 w-3.5" />
          Ignore rules{view.ignoreIsDefault ? '' : ' *'}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Ignored paths</DialogTitle>
        <DialogDescription>
          One pattern per line, as in .gitignore: <span className="mono">vendor/</span> is a
          directory anywhere, <span className="mono">/docs/</span> only at the root,{' '}
          <span className="mono">*.min.js</span> a file name, <span className="mono">**</span>{' '}
          crosses directories. Ignored files are listed with the commit but never read, chunked or
          embedded.{' '}
          {view.ignoreIsDefault ? 'These are the defaults.' : 'This list replaces the defaults.'}
        </DialogDescription>
        <textarea
          className="field mono mt-3 h-[260px] w-full resize-y p-2 text-[12.5px]"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          data-ignore-rules
        />
        {problem ? (
          <p role="alert" className="mt-2 text-[12.5px] text-danger">
            {problem}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={saving || view.ignoreIsDefault}
            onClick={() => save({ ignorePaths: null }, false)}
          >
            Reset to defaults
          </Button>
          <span className="flex gap-2">
            <DialogClose asChild>
              <Button variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => save({ ignorePaths: text }, false)}
            >
              Save
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={saving}
              onClick={() => save({ ignorePaths: text }, true)}
              data-save-and-reindex
            >
              Save and re-index
            </Button>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Every file of the commit in the order the indexer walks them, with the
 * indexer's position: done, the current one, and what remains. Skips decided
 * at read time (limits, binaries) are known before the index step starts.
 */
function FileList({ view }: { view: IngestView }) {
  const files = view.files!
  const index = view.steps.find((s) => s.step === 'index')
  const progress = index?.progress
  // The indexer walks the files that are not ignored, in this order; its position counts those.
  const walked = files.filter((f) => !f.ignoredBy)
  const position =
    index?.status === 'done'
      ? walked.length
      : progress && progress.phase === 'files'
        ? progress.done
        : progress
          ? walked.length
          : 0
  const remaining = Math.max(0, walked.length - position)
  const ignoredCount = files.length - walked.length
  const positionOf = new Map(walked.map((f, i) => [f.path, i]))
  const currentRef = useRef<HTMLLIElement>(null)
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest' })
  }, [position])
  return (
    <details className="mt-4" open data-file-list>
      <summary className="cursor-pointer text-[12.5px] text-content-secondary">
        {files.length} files · {position} done · {remaining} remaining
        {ignoredCount ? ` · ${ignoredCount} ignored` : ''}
      </summary>
      <ol className="scroll mt-2 max-h-[280px] overflow-y-auto rounded-md bg-raised p-2 text-[12px]">
        {files.map((file) => {
          const i = positionOf.get(file.path)
          const state =
            i === undefined
              ? 'ignored'
              : i < position
                ? 'done'
                : i === position
                  ? 'current'
                  : 'remaining'
          return (
            <li
              key={file.path}
              ref={state === 'current' ? currentRef : undefined}
              data-file-state={state}
              className={`grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 px-1 py-0.5 ${
                state === 'remaining' || state === 'ignored'
                  ? 'text-content-muted'
                  : 'text-content-primary'
              } ${state === 'current' ? 'bg-hover' : ''} ${state === 'ignored' ? 'opacity-60' : ''}`}
            >
              {state === 'done' ? (
                <Check className="h-3.5 w-3.5 text-success" />
              ) : state === 'current' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-content-secondary" />
              ) : (
                <span className="text-center">·</span>
              )}
              <span className="mono truncate">{file.path}</span>
              <span className="text-[11px] text-content-muted">
                {file.ignoredBy
                  ? `ignored: ${file.ignoredBy}`
                  : file.skipReason
                    ? `skipped: ${SKIP_REASONS[file.skipReason] ?? file.skipReason}`
                    : file.change !== 'added' && file.change !== 'unchanged'
                      ? file.change
                      : ''}
              </span>
            </li>
          )
        })}
      </ol>
    </details>
  )
}

/** The running totals the worker reports with every file. */
function Counts({ counts }: { counts: NonNullable<StepProgress['counts']> }) {
  const skipped = Object.entries(counts.filesSkipped)
  const skippedTotal = skipped.reduce((n, [, v]) => n + v, 0)
  /**
   * What the flag means, and where it is (owner, 2026-09-18). Never a verdict: the detector's
   * recall is 0.405, so no flag is not evidence of a clean repository, and it gates nothing
   *. Absence is why this cell is only rendered when the count is non-zero — there is
   * no zero state that could be read as safety.
   */
  const flaggedTitle = (c: {
    flagged: number
    flaggedSpans?: Array<{ path: string; start: number; end: number }>
  }) => {
    const where = (c.flaggedSpans ?? []).map((s) => `${s.path}:${s.start}-${s.end}`)
    const shown = where.slice(0, 12).join('\n')
    const rest = where.length > 12 ? `\n… and ${where.length - 12} more` : ''
    return [
      'Chunks whose comments or strings read as instructions to a model.',
      'A signal on the evidence, never a gate: nothing was excluded, and the detector misses much of what it looks for.',
      where.length ? `\n${shown}${rest}` : '',
    ]
      .filter(Boolean)
      .join(' ')
  }

  const cell = (label: string, value: number | string, title?: string) => (
    <span className="inline-flex items-baseline gap-1" title={title}>
      <span className="mono text-content-primary">{value}</span>
      <span>{label}</span>
    </span>
  )
  return (
    <span
      className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-content-muted"
      data-step-counts
    >
      {cell('parsed', counts.filesParsed)}
      {cell('reused', counts.filesCopied, 'unchanged since the previous commit')}
      {cell(
        'skipped',
        skippedTotal,
        skipped.map(([k, v]) => `${v} ${SKIP_REASONS[k] ?? k}`).join(', ') || undefined
      )}
      {cell('symbols', counts.symbols)}
      {cell('chunks', counts.chunks)}
      {cell(
        'embeddings',
        `${counts.embeddingsComputed}+${counts.embeddingsCached}`,
        'computed + served from the cache'
      )}
      {counts.flagged ? cell('flagged', counts.flagged, flaggedTitle(counts)) : null}
      {counts.endpoints ? cell('endpoints', counts.endpoints) : null}
      {counts.dependencies ? cell('dependencies', counts.dependencies) : null}
      {counts.cloneClasses ? cell('clone classes', counts.cloneClasses) : null}
    </span>
  )
}

export function CommitPill({ view }: { view: IngestView }) {
  return (
    <span
      className="outline-ring inline-flex h-7 items-center gap-1.5 px-2 text-content-secondary"
      title="Answers are pinned to this commit"
    >
      <GitCommitHorizontal className="h-3.5 w-3.5" />
      <span className="mono">{view.activeCommit ? view.activeCommit.sha.slice(0, 7) : '—'}</span>
    </span>
  )
}

/**
 * The list behind the flagged count: each flagged chunk of the active commit with the
 * sentence the classifier read — the window of its prose that tripped the detector, quoted and
 * inert. A signal on the evidence, never a verdict: nothing was excluded, and the detector misses
 * much of what it looks for (recall 0.405).
 */
function FlaggedChunks({ chunks }: { chunks: NonNullable<IngestView['flaggedChunks']> }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-flagged-toggle
          title="Chunks whose comments or strings read as instructions to a model"
        >
          <AlertTriangle className="h-3.5 w-3.5 text-warning" />
          Flagged {chunks.length}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Flagged chunks</DialogTitle>
        <DialogDescription data-flagged-summary>
          {chunks.length} chunk{chunks.length === 1 ? '' : 's'} classified as instruction-shaped by
          the detector; a signal, not a verdict. Each shows the prose the classifier read. Nothing
          was excluded from the index, and the detector misses much of what it looks for.
        </DialogDescription>
        <ol className="mt-3 grid max-h-[60vh] gap-3 overflow-y-auto" data-flagged-list>
          {chunks.map((c) => (
            <li key={c.chunkId} className="text-[12.5px]" data-flagged-chunk={c.chunkId}>
              <span className="mono text-content-secondary">
                {c.path}:{c.start}–{c.end}
              </span>
              {c.window !== null && c.window > 0 ? (
                <span className="ml-2 text-[11.5px] text-content-muted">window {c.window + 1}</span>
              ) : null}
              <blockquote className="mt-1 whitespace-pre-wrap border-l-2 border-warning/60 pl-2 text-content-primary">
                {c.text || 'the chunk’s prose is no longer extracted under the current rules'}
              </blockquote>
            </li>
          ))}
        </ol>
      </DialogContent>
    </Dialog>
  )
}
