import { CircleCheck, CircleDashed, CircleX, LoaderCircle, PauseCircle } from 'lucide-react'
import type { RunState } from '../../../app/assistant/protocol'

/**
 * Every RunState has a rendering. The Record type is exhaustive:
 * omitting a state is a type error (AC-WP06-23), so a future
 * `awaiting_input` cannot reach the client unrendered.
 */
export const RUN_STATE_VIEW: Record<
  RunState,
  { label: string; tone: 'live' | 'wait' | 'done' | 'stop' | 'fail' }
> = {
  running: { label: 'Answering', tone: 'live' },
  awaiting_input: { label: 'Waiting for a decision', tone: 'wait' },
  completed: { label: 'Completed', tone: 'done' },
  cancelled: { label: 'Cancelled', tone: 'stop' },
  failed: { label: 'Failed', tone: 'fail' },
}

const ICONS = {
  live: LoaderCircle,
  wait: PauseCircle,
  done: CircleCheck,
  stop: CircleDashed,
  fail: CircleX,
} as const

export function RunStateBadge({ state, detail }: { state: RunState; detail?: string }) {
  const view = RUN_STATE_VIEW[state]
  const Icon = ICONS[view.tone]
  return (
    <span
      className={`run-state run-state-${view.tone} inline-flex items-center gap-1 text-xs`}
      data-run-state={state}
    >
      <Icon className={`h-3.5 w-3.5 ${view.tone === 'live' ? 'spin' : ''}`} />
      {view.label}
      {detail ? <span className="run-state-detail"> · {detail}</span> : null}
    </span>
  )
}
