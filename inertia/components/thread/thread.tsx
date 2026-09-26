import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Eraser, GitCommitHorizontal, MessageSquareText } from 'lucide-react'
import type { AnswerEvent } from '../../../app/assistant/protocol'
import {
  reauthenticate,
  sessionExpired,
  streamTurn,
  xsrfToken,
  type StreamHandle,
} from '../../lib/answer_stream'
import { PageHeader } from '~/components/shell/page_header'
import { Answer, type TurnCostView } from './answer'
import { ReindexContext } from './views'
import { DecisionDrawer } from './decision_drawer'
import { EvidenceList } from './evidence_list'
import { FilePane } from './file_pane'
import { DeclarationPane, type DeclarationView } from './declaration_pane'
import { QueryBox } from './query_box'
import { sourcesOf } from './sources'

interface Turn {
  question: string
  events: AnswerEvent[]
  rejected?: string
  /** What the refused paste named that the index can answer (WP-19, BL-09). */
  rejectedSuggestions?: string[]
  regenerated?: boolean
  /** From the ledger once the turn is over. */
  cost?: TurnCostView | null
  /** Browser clock: when the question was sent and when the run ended (live turns only). */
  startedAt?: number
  finishedAt?: number
}

/** A turn as the page loads it back: the released answer text, its citations, its cost. */
interface HistoryTurn {
  runHandle: string
  question: string
  answerText: string
  /** The released stream as it happened; absent on turns stored before it was kept. */
  events?: AnswerEvent[] | null
  runState: 'completed' | 'failed' | 'cancelled'
  createdAt: string
  citations: Array<{ handle: string; path: string; startLine: number; endLine: number }>
  cost: TurnCostView | null
}

/** History turns render through the same Answer: the text as one delta, the run state as a status. */
function eventsOfHistory(turn: HistoryTurn): AnswerEvent[] {
  // A turn stored with its released stream renders as it streamed: chips, marks and views.
  if (turn.events?.length) return turn.events
  return [
    { type: 'status', label: 'from history', runId: turn.runHandle, runState: turn.runState },
    ...(turn.answerText ? [{ type: 'text' as const, delta: turn.answerText }] : []),
  ]
}

interface ScopeInfo {
  commitSha: string | null
  suggestedQuestions: string[]
  inputCap: number
  estimate?: { usd: number; basis: 'recent' | 'budget'; priceVersion: string } | null
}

/**
 * The thread, laid out like a reading pane: answers on the left, the
 * evidence rail beside them, and a cited file open on the right. One
 * Answer per turn, continued by thread handle; the composer sits at the
 * bottom of the answer column.
 */
export function Thread({
  workspace,
  repository,
  repositoryName,
  user,
  actions,
  onReindex,
  assetsVersion,
}: {
  workspace: string
  repository: string
  repositoryName: string
  user: { fullName: string | null; initials: string }
  /** Header actions beside the commit pill (re-index, delete) for those who may manage. */
  actions?: ReactNode
  /** Forces a re-index from inside an answer; given only to those who may manage. */
  onReindex?: () => Promise<void>
  /** The build this page rendered with (from the page props); a turn from a newer one asks for a reload. */
  assetsVersion?: string
}) {
  const base = `/api/w/${workspace}/r/${repository}`
  const [scope, setScope] = useState<ScopeInfo>({
    commitSha: null,
    suggestedQuestions: [],
    inputCap: 400,
  })
  const [turns, setTurns] = useState<Turn[]>([])
  const turnCount = useRef(0)
  // Set once a question has been asked. Guards the async history load from overwriting an in-flight
  // turn: submitting before `/history` resolves would otherwise `setTurns(history)` over the live
  // answer — for a fresh repo, `setTurns([])` — wiping it and hanging the run at "running".
  const started = useRef(false)
  const [busy, setBusy] = useState(false)
  /**
   * A set question's batches run on by themselves (amended 2026-09-17): after a batch
   * completes with a next question, nothing withheld and no notice, the page asks it. Stop, a
   * withheld or failed batch, or the cap ends the run.
   */
  const MAX_AUTO_BATCHES = 12
  const auto = useRef<{ remaining: number; stopped: boolean; timer: number | null }>({
    remaining: 0,
    stopped: true,
    timer: null,
  })
  const [autoNext, setAutoNext] = useState<string | null>(null)
  /** A turn answered by a newer build than this page loaded: the reader reloads to get it. */
  const [staleBuild, setStaleBuild] = useState(false)
  const stopAuto = () => {
    auto.current.stopped = true
    if (auto.current.timer) window.clearTimeout(auto.current.timer)
    auto.current.timer = null
    setAutoNext(null)
  }
  /** The next batch to ask, if this completed turn's events say the set goes on and nothing stopped it. */
  const nextBatch = (events: AnswerEvent[]): string | null => {
    let next: string | null = null
    let completed = false
    for (const e of events) {
      if (e.type === 'status') completed = e.runState === 'completed'
      if (e.type === 'view' && e.component === 'set_progress')
        next = (e.data as { next?: string | null }).next ?? null
      // A withheld run is marked where it was and does not end the set; a notice or an
      // error does.
      if (e.type === 'view' && e.component === 'scope_notice') return null
      if (e.type === 'error') return null
    }
    return completed ? next : null
  }
  const [drawer, setDrawer] = useState<string | null>(null)
  const [activeSource, setActiveSource] = useState<string | null>(null)
  const [activeDeclaration, setActiveDeclaration] = useState<DeclarationView | null>(null)
  // Open an uncited declaration's own code in the right-hand pane, no model turn. Closes
  // the cited-source pane so only one reading pane is ever open.
  const openDeclaration = async (d: { name: string; path: string; line: number }) => {
    setActiveSource(null)
    try {
      const response = await fetch(
        `${base}/declaration?path=${encodeURIComponent(d.path)}&line=${d.line}`,
        { headers: { Accept: 'application/json' } }
      )
      if (response.ok) setActiveDeclaration((await response.json()) as DeclarationView)
    } catch {
      // A failed fetch leaves the panes as they were; the grey box can be clicked again.
    }
  }
  const threadHandle = useRef<string | undefined>(undefined)
  const active = useRef<StreamHandle | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  // A GET that re-authenticates on an expired session (a redirected or 401 response) rather than
  // parsing an HTML login page as JSON (UAT 2026-09-17).
  const apiGet = useCallback(<T,>(path: string): Promise<T | null> => {
    return fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then((r) => {
        if (sessionExpired(r)) {
          reauthenticate()
          return null
        }
        return r.json() as Promise<T>
      })
      .catch(() => null)
  }, [])

  const loadScope = useCallback(
    () =>
      apiGet<ScopeInfo>(`${base}/scope`).then((data) => {
        if (data) setScope(data)
      }),
    [apiGet, base]
  )
  useEffect(() => {
    void loadScope()
  }, [loadScope])

  // The reader's thread for this repository, as it was left; the next question continues it.
  useEffect(() => {
    apiGet<{ threadHandle: string | null; turns: HistoryTurn[] }>(`${base}/history`).then(
      (data) => {
        if (!data) return
        // A question asked before this resolved owns the thread now; don't clobber its live turn.
        if (started.current) return
        threadHandle.current = data.threadHandle ?? undefined
        turnCount.current = data.turns.length
        setTurns(
          data.turns.map((t) => ({
            question: t.question,
            events: eventsOfHistory(t),
            cost: t.cost,
          }))
        )
      }
    )
  }, [apiGet, base])

  /** The turn's cost from the ledger, once its run is over; the estimate follows it. */
  const settleCost = (index: number, runHandle: string) => {
    void apiGet<{ threadHandle: string | null; turns: HistoryTurn[] }>(`${base}/history`).then(
      (data) => {
        if (!data) return
        threadHandle.current = data.threadHandle ?? threadHandle.current
        const cost = data.turns.find((t) => t.runHandle === runHandle)?.cost ?? null
        setTurns((t) => t.map((turn, i) => (i === index ? { ...turn, cost } : turn)))
      }
    )
    void loadScope()
  }

  const clearHistory = () => {
    if (!window.confirm('Clear this conversation? The questions and answers are erased.')) return
    fetch(`${base}/history`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'X-XSRF-TOKEN': xsrfToken() },
    })
      .then((r) => {
        if (sessionExpired(r)) {
          reauthenticate()
          return
        }
        if (!r.ok) throw new Error(`clear failed (${r.status})`)
        threadHandle.current = undefined
        turnCount.current = 0
        setTurns([])
      })
      .catch(() => undefined)
  }

  const run = (
    question: string,
    regenerate?: { turnHandle: string; invalidEntities: string[] },
    continuing = false
  ) => {
    // The next turn's index, from a counter: a run started by a timer (auto-continue) would
    // otherwise read a stale `turns` and patch its events into the previous turn.
    const index = turnCount.current++
    started.current = true
    if (!continuing) {
      // A fresh question starts a fresh allowance of batches.
      stopAuto()
      auto.current = { remaining: MAX_AUTO_BATCHES, stopped: false, timer: null }
    }
    const collected: AnswerEvent[] = []
    setTurns((t) => [...t, { question, events: [], startedAt: Date.now() }])
    setBusy(true)
    const patch = (fn: (turn: Turn) => Turn) =>
      setTurns((t) => t.map((turn, i) => (i === index ? fn(turn) : turn)))
    active.current = streamTurn(
      `${base}/turns`,
      { question, threadHandle: threadHandle.current, regenerate },
      (event) => {
        collected.push(event)
        const ended = event.type === 'status' && event.runState !== 'running'
        patch((turn) => ({
          ...turn,
          events: [...turn.events, event],
          finishedAt: ended ? (turn.finishedAt ?? Date.now()) : turn.finishedAt,
        }))
        if (event.type === 'status' && event.runState !== 'running') settleCost(index, event.runId)
      },
      (message, suggestions) =>
        patch((turn) => ({ ...turn, rejected: message, rejectedSuggestions: suggestions })),
      (version) => {
        if (assetsVersion && version !== assetsVersion) setStaleBuild(true)
      }
    )
    active.current.done.finally(() => {
      setBusy(false)
      const next = nextBatch(collected)
      if (!next || auto.current.stopped || auto.current.remaining <= 1) {
        setAutoNext(null)
        return
      }
      auto.current.remaining--
      setAutoNext(next)
      auto.current.timer = window.setTimeout(() => {
        auto.current.timer = null
        if (!auto.current.stopped) run(next, undefined, true)
      }, 800)
    })
  }

  const sources = useMemo(() => sourcesOf(turns), [turns])
  const sourceList = useMemo(() => [...sources.values()], [sources])
  const current = activeSource ? sources.get(activeSource) : undefined
  const latest = turns[turns.length - 1]
  const trail = useMemo(
    () =>
      latest
        ? [
            ...new Set(
              latest.events
                .filter((e): e is Extract<AnswerEvent, { type: 'status' }> => e.type === 'status')
                .map((e) => e.label)
                .filter(Boolean)
            ),
          ]
        : [],
    [latest]
  )

  // J/K move between sources and Escape closes the file, unless a field or a dialog has focus.
  useEffect(() => {
    if (!current) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (document.querySelector('[role="dialog"]')) return
      const i = sourceList.findIndex((s) => s.key === current.key)
      if (e.key === 'Escape') {
        setActiveSource(null)
        setActiveDeclaration(null)
      }
      if ((e.key === 'j' || e.key === ']') && i < sourceList.length - 1)
        setActiveSource(sourceList[i + 1].key)
      if ((e.key === 'k' || e.key === '[') && i > 0) setActiveSource(sourceList[i - 1].key)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, sourceList])

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [turns.length])

  return (
    <ReindexContext.Provider value={onReindex ?? null}>
      <div className="thread flex min-h-0 flex-1">
        <section aria-label="Answer" className="flex min-w-[340px] flex-1 flex-col">
          <PageHeader
            title={
              <>
                <MessageSquareText className="h-3.5 w-3.5 text-content-muted" />
                Ask
              </>
            }
          >
            <span
              className="outline-ring inline-flex h-7 items-center gap-1.5 px-2 text-content-secondary"
              title="Answers are pinned to this commit"
            >
              <GitCommitHorizontal className="h-3.5 w-3.5" />
              <span className="mono">{scope.commitSha ? scope.commitSha.slice(0, 7) : '—'}</span>
            </span>
            {turns.length > 0 ? (
              <button
                type="button"
                className="outline-ring inline-flex h-7 items-center gap-1.5 px-2 text-content-secondary"
                onClick={clearHistory}
                disabled={busy}
                title="Erase this conversation's questions and answers (audit records stay)"
                data-clear-history
              >
                <Eraser className="h-3.5 w-3.5" />
                Clear history
              </button>
            ) : null}
            {actions}
          </PageHeader>

          <div className="scroll flex-1">
            <div className="mx-auto max-w-[700px] px-7 pb-6 pt-8">
              {turns.length === 0 ? (
                <div className="py-10 text-center text-content-muted">
                  <p className="text-[15px] font-medium text-content-secondary">
                    Ask about {repositoryName}
                  </p>
                  <p className="mt-1 text-[12.5px]">
                    Answers cite the exact lines they come from. Pick a suggestion below or type a
                    question.
                  </p>
                </div>
              ) : null}
              {turns.map((turn, i) => (
                <div key={i} className="turn mb-8">
                  <div className="mb-5 grid grid-cols-[26px_minmax(0,1fr)] gap-3">
                    <span className="avatar h-[26px] w-[26px] text-[11px]">{user.initials}</span>
                    <div>
                      <div className="mb-1 flex h-6 items-center gap-2">
                        <span className="font-semibold">{user.fullName ?? 'You'}</span>
                      </div>
                      <p className="question m-0 text-[14.5px] leading-relaxed">{turn.question}</p>
                    </div>
                  </div>
                  {turn.rejected ? (
                    <div data-rejected>
                      <p className="rejected">{turn.rejected}</p>
                      {turn.rejectedSuggestions?.length ? (
                        <ul className="suggestions mt-2" data-rejected-suggestions>
                          {turn.rejectedSuggestions.map((q) => (
                            <li key={q}>
                              <button type="button" disabled={busy} onClick={() => run(q)}>
                                {q}
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : (
                    <Answer
                      events={turn.events}
                      cost={turn.cost}
                      grounding={{ repository: repositoryName, commitSha: scope.commitSha }}
                      apiBase={base}
                      latencyMs={
                        turn.startedAt && turn.finishedAt ? turn.finishedAt - turn.startedAt : null
                      }
                      onAsk={(q) => run(q)}
                      onDecision={(handle) => setDrawer(handle)}
                      regenerated={turn.regenerated}
                      turn={i}
                      sources={sources}
                      activeSource={activeSource}
                      onOpenSource={(key) => {
                        setActiveDeclaration(null)
                        setActiveSource((s) => (s === key ? null : key))
                      }}
                      onOpenDeclaration={openDeclaration}
                      onRegenerate={(invalid) => {
                        const status = turn.events.find((e) => e.type === 'status') as
                          { runId: string } | undefined
                        if (!status) return
                        setTurns((t) =>
                          t.map((x, j) => (j === i ? { ...x, regenerated: true } : x))
                        )
                        run(turn.question, { turnHandle: status.runId, invalidEntities: invalid })
                      }}
                    />
                  )}
                </div>
              ))}
              <div ref={bottom} />
            </div>
          </div>

          <div className="flex-none px-7 pb-4">
            {staleBuild ? (
              <p className="mb-2 flex items-center gap-3 text-[13px] text-warning" data-stale-build>
                <span>
                  A newer version of this page was deployed; this answer used it, but the page did
                  not.
                </span>
                <button
                  type="button"
                  className="underline"
                  onClick={() => window.location.reload()}
                >
                  Reload
                </button>
              </p>
            ) : null}
            {autoNext ? (
              <p
                className="mb-2 flex items-center gap-3 text-[13px] text-content-muted"
                data-auto-continue
              >
                <span>Continuing with the next batch: {autoNext}</span>
                <button type="button" className="underline" onClick={stopAuto} data-auto-stop>
                  Stop
                </button>
              </p>
            ) : null}
            <QueryBox
              repository={repositoryName}
              commitSha={scope.commitSha}
              suggestedQuestions={scope.suggestedQuestions}
              inputCap={scope.inputCap}
              busy={busy}
              onAsk={(q) => run(q)}
              onStop={() => active.current?.abort()}
              estimate={scope.estimate}
            />
          </div>
        </section>

        <EvidenceList
          sources={sourceList}
          trail={trail}
          active={activeSource}
          onOpen={setActiveSource}
        />
        {current ? (
          <FilePane
            key={current.key}
            source={current}
            sources={sourceList}
            onOpen={setActiveSource}
          />
        ) : activeDeclaration ? (
          <DeclarationPane
            declaration={activeDeclaration}
            onClose={() => setActiveDeclaration(null)}
          />
        ) : null}
        {drawer ? (
          <DecisionDrawer base={base} turnHandle={drawer} onClose={() => setDrawer(null)} />
        ) : null}
      </div>
    </ReindexContext.Provider>
  )
}
