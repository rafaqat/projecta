import { useCallback, useEffect, useState } from 'react'
import { CircleCheck, Flag, ScrollText } from 'lucide-react'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '~/components/ui/sheet'
import { evidenceState } from '../../../app/audit/evidence_state'
import { reauthenticate, sessionExpired } from '../../lib/answer_stream'

/**
 * The decision drawer (design §9): what the answer was built from and how
 * it was checked, from the decision record, plus accept/flag reviews that
 * append decision.reviewed. Everything shown is a reference or a count;
 * question and answer text are never in the record.
 */
/** The mechanism that removed the last evidence, in the reviewer's words (WP-19, BL-00). */
/**
 * What the gateway said it did. Decisions, never contents: outcomes, rule ids and
 * counts. Absent means no gateway was in the path — a different fact from "nothing fired", and
 * shown as such, because confusing the two cost a day of debugging on 2026-09-18.
 */
function GatewayDecisions({ decisions }: { decisions: Record<string, unknown> | null }) {
  if (!decisions) {
    return (
      <p data-gateway-decisions="absent" className="text-content-muted">
        The gateway reported nothing for this turn: none was in the path, or it predates this
        record. This is not the same as nothing having fired.
      </p>
    )
  }
  const inbound = (decisions.inbound ?? {}) as Record<string, unknown>
  const outbound = decisions.outbound as Record<string, unknown> | undefined
  const checks = ['attribution', 'model', 'configHash', 'prompt', 'tools'] as const
  const rules = (inbound.rules as string[] | undefined) ?? []
  return (
    <div data-gateway-decisions="present" className="flex flex-col gap-1">
      <p>
        {checks.map((name) => (
          <span key={name} data-check={name} data-outcome={String(inbound[name] ?? 'skipped')}>
            {name} {String(inbound[name] ?? 'skipped')}
            {'  '}
          </span>
        ))}
      </p>
      <p>
        {rules.length ? `rules fired: ${rules.join(', ')}` : 'no inbound rule fired'} ·{' '}
        {Number(inbound.masked ?? 0)} personal-data span(s) masked ·{' '}
        {inbound.injectionSuspected ? 'annotated as instruction-shaped' : 'not annotated'} by{' '}
        {String(inbound.detector ?? 'none')}
        {inbound.detectorFailed ? ' (detector unavailable)' : ''}
      </p>
      {outbound ? (
        <p data-gateway-outbound>
          answer checked against {((outbound.rules as string[]) ?? []).join(', ') || 'no rules'};{' '}
          {outbound.blockedBy ? `ended by ${String(outbound.blockedBy)}` : 'released whole'}
        </p>
      ) : (
        <p data-gateway-outbound="absent" className="text-content-muted">
          The outbound half is not recorded here: the provider SDK drops the frame that carries it .
          What it blocked, if anything, is in the policy events above.
        </p>
      )}
    </div>
  )
}

const WITHHELD_BY_TEXT: Record<string, string> = {
  retrieval_insufficient: 'retrieval (nothing sufficient was found)',
  no_citation: 'the model (it cited nothing)',
  hydration_rejected: 'hydration (every citation named an unknown handle or block)',
  budget_exhausted: 'the connective or background budget',
  quoted_comment: 'the gate (uncited text repeated a comment from the code word for word)',
  gate_error: 'a gate error',
}

interface Decision {
  turn: { handle: string; runState: string; released: boolean; erased: boolean }
  chained: boolean
  record: {
    occurredAt: string
    system: {
      appVersion: string
      imageDigest: string
      configHash: string
      validatedByRun: string | null
    }
    input: {
      inputLength: number
      scope: { label: string; stage: string; ruleId: string } | null
      injectionSuspected: boolean
    }
    evidence: {
      commitSha: string
      model: string
      modelCalls: number
      retrieval: {
        shown: number
        total: number
        truncated: boolean
        queriesRun: string[]
        candidates: Array<{
          path: string
          span: { start: number; end: number }
          rank: number
          injectionSuspected?: boolean
        }>
      } | null
      citations: Array<{
        handle: string
        path: string
        span: { start: number; end: number }
        spanSha256: string
      }>
      dropped: string[]
      tools: Array<{ name: string; status: string }>
      gate: {
        evidence: boolean
        declined: boolean
        withheldChars: number
        withheldBy: string | null
        demand: { connectiveSentences: number; backgroundTokens: number }
      }
      verification: { verified: number; unverified: number; not_checkable?: number }
      injectionSuspected: number
    }
    outcome: { runState: string; noticeKind: string | null }
  } | null
  reviews: Array<{
    outcome: string
    note: string
    reviewer: string
    reviewedAt: string
    chained: boolean
  }>
  validation: { status: string; run?: string }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function xsrf(): string {
  const m = /XSRF-TOKEN=([^;]+)/.exec(document.cookie)
  return m ? decodeURIComponent(m[1]) : ''
}

export function DecisionDrawer({
  base,
  turnHandle,
  onClose,
}: {
  base: string
  turnHandle: string
  onClose: () => void
}) {
  const [data, setData] = useState<Decision | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(
    () =>
      fetch(`${base}/turns/${turnHandle}/decision`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      })
        .then((r) => {
          if (sessionExpired(r)) return reauthenticate()
          return r.ok ? r.json() : Promise.reject(new Error(String(r.status)))
        })
        .then((d: Decision | void) => d && setData(d))
        .catch((e: Error) => setError(e.message)),
    [base, turnHandle]
  )
  useEffect(() => {
    void load()
  }, [load])
  const review = async (outcome: 'accept' | 'flag') => {
    const r = await fetch(`${base}/turns/${turnHandle}/review`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf() },
      body: JSON.stringify({ outcome, note }),
    })
    if (sessionExpired(r)) return reauthenticate()
    if (r.ok) {
      setNote('')
      await load()
    } else setError(`review failed (${r.status})`)
  }
  const citations = data?.record?.evidence.citations ?? []
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent data-decision-drawer className="drawer">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <ScrollText className="h-4 w-4 text-content-secondary" />
            <SheetTitle className="text-base font-semibold text-content-primary">
              Decision record
            </SheetTitle>
            <Badge>
              <span className="mono">{turnHandle.slice(0, 12)}</span>
            </Badge>
          </div>
          <SheetDescription className="mt-1 text-[12.5px] text-content-muted">
            What this answer was built from and how it was checked, linked to the audit chain.
          </SheetDescription>
        </SheetHeader>
        <div className="scroll flex-1 space-y-5 px-5 py-4">
          {error ? <p className="error">{error}</p> : null}
          {!data ? <p className="muted">Loading…</p> : null}
          {data && !data.record ? <p className="muted">No record yet.</p> : null}
          {data?.record ? (
            <>
              <section>
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-xs font-medium text-content-muted">Configuration</span>
                  <span
                    className={`badge badge-${data.validation.status === 'validated' ? 'ok' : 'warn'}`}
                    data-validation
                  >
                    {data.validation.status === 'validated'
                      ? `validated by ${data.validation.run}`
                      : data.validation.status}
                  </span>
                  <Badge tone="muted">
                    {data.chained ? 'in audit chain' : 'awaiting audit writer'}
                  </Badge>
                </div>
                <dl className="record">
                  <Row label="Model">
                    <span data-model>
                      {data.record.evidence.model} · {data.record.evidence.modelCalls} call(s)
                    </span>
                  </Row>
                  <Row label="configHash">
                    <code data-config-hash>{data.record.system.configHash}</code>
                    {/* What this system is, beside what this answer came from. */}
                    <a
                      href="/about"
                      data-about-link
                      className="ml-2 text-[12px] text-content-muted underline hover:text-content-primary"
                    >
                      About this deployment
                    </a>
                  </Row>
                  <Row label="Commit">
                    <code>{data.record.evidence.commitSha.slice(0, 12)}</code>
                  </Row>
                  <Row label="Scope">
                    {data.record.input.scope
                      ? `${data.record.input.scope.label} (${data.record.input.scope.stage}, ${data.record.input.scope.ruleId})`
                      : '—'}
                  </Row>
                  <Row label="Gate">
                    <span
                      data-gate
                      data-withheld-by={data.record.evidence.gate.withheldBy ?? 'none'}
                    >
                      {data.record.evidence.gate.evidence ? 'evidence found' : 'no evidence'}
                      {data.record.evidence.gate.declined ? ' · declined part' : ''}
                      {data.record.evidence.gate.withheldChars
                        ? ` · ${data.record.evidence.gate.withheldChars} chars withheld`
                        : ''}
                      {data.record.evidence.gate.withheldBy
                        ? ` · withheld by ${WITHHELD_BY_TEXT[data.record.evidence.gate.withheldBy]}`
                        : ''}
                    </span>
                  </Row>
                  <Row label="Verification">
                    <span data-verification-counts>
                      {data.record.evidence.verification.verified} verified ·{' '}
                      {data.record.evidence.verification.unverified} unverified
                      {data.record.evidence.verification.not_checkable
                        ? ` · ${data.record.evidence.verification.not_checkable} can’t be checked`
                        : ''}
                    </span>
                  </Row>
                  <Row label="Question">
                    <span
                      data-question-flagged={String(data.record.input.injectionSuspected)}
                      className={data.record.input.injectionSuspected ? 'text-warning' : ''}
                    >
                      {data.record.input.injectionSuspected
                        ? 'scored as instruction-shaped by the injection detector; answered on evidence regardless'
                        : 'not flagged by the injection detector'}
                    </span>
                  </Row>
                  <Row label="Gateway">
                    <GatewayDecisions
                      decisions={
                        (data.record as { gateway?: Record<string, unknown> | null }).gateway ??
                        null
                      }
                    />
                  </Row>
                  <Row label="Flagged content">
                    <span
                      data-injection-suspected={String(data.record.evidence.injectionSuspected)}
                      className={data.record.evidence.injectionSuspected ? 'text-warning' : ''}
                    >
                      {data.record.evidence.injectionSuspected
                        ? `${data.record.evidence.injectionSuspected} retrieved span(s) flagged at ingest as instruction-shaped`
                        : 'none of the retrieved spans was flagged at ingest'}
                    </span>
                  </Row>
                  <Row label="Tools">
                    {data.record.evidence.tools.length
                      ? data.record.evidence.tools.map((t) => `${t.name} (${t.status})`).join(', ')
                      : 'none'}
                  </Row>
                </dl>
              </section>
              <section>
                <div className="mb-1 text-xs font-medium text-content-muted">Evidence</div>
                <ul className="evidence m-0 list-none p-0" data-evidence>
                  {(data.record.evidence.retrieval?.candidates ?? []).map((c) => {
                    const state = evidenceState(c, citations)
                    return (
                      <li
                        key={`${c.rank}`}
                        data-evidence-state={state}
                        className="flex items-center gap-2 border-b border-line py-1.5 text-xs"
                      >
                        <span className="w-6 text-content-muted">#{c.rank}</span>
                        <code className="min-w-0 flex-1 truncate">{c.path}</code>
                        <span className="text-content-muted">
                          L{c.span.start}–{c.span.end}
                        </span>
                        {c.injectionSuspected ? (
                          <Badge tone="warn" icon={Flag} data-flagged-candidate="true">
                            flagged
                          </Badge>
                        ) : null}
                        <Badge tone={state === 'used' ? 'ok' : 'muted'}>{state}</Badge>
                      </li>
                    )
                  })}
                  {data.record.evidence.dropped.map((p) => (
                    <li
                      key={`dropped-${p}`}
                      data-evidence-state="dropped"
                      className="flex items-center gap-2 border-b border-line py-1.5 text-xs"
                    >
                      <span className="w-6" />
                      <code className="min-w-0 flex-1 truncate">{p}</code>
                      <Badge tone="bad">dropped</Badge>
                    </li>
                  ))}
                </ul>
              </section>
              <section>
                <div className="mb-2 text-xs font-medium text-content-muted">Reviews</div>
                <ul className="timeline m-0 list-none p-0" data-reviews>
                  {data.reviews.map((r, i) => (
                    <li
                      key={i}
                      className="grid grid-cols-[18px_minmax(0,1fr)_auto] gap-2.5 py-1.5 text-[12.5px]"
                    >
                      {r.outcome === 'accept' ? (
                        <CircleCheck className="mt-0.5 h-4 w-4 text-success" />
                      ) : (
                        <Flag className="mt-0.5 h-4 w-4 text-danger" />
                      )}
                      <span className="text-content-secondary">
                        <span className={`badge badge-${r.outcome === 'accept' ? 'ok' : 'bad'}`}>
                          {r.outcome}
                        </span>{' '}
                        {r.note || <span className="muted">no note</span>}
                      </span>
                      <span className="mono text-content-muted">
                        {new Date(r.reviewedAt).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
                <textarea
                  value={note}
                  maxLength={500}
                  rows={2}
                  placeholder="Review note (optional)"
                  aria-label="Review note"
                  className="field mt-2 w-full resize-none px-3 py-2 text-[13px] placeholder:text-content-muted"
                  onChange={(e) => setNote(e.target.value)}
                />
                <div className="mt-2 flex items-center gap-1.5">
                  <Button onClick={() => review('accept')} data-review="accept">
                    <CircleCheck className="h-3.5 w-3.5" />
                    Accept
                  </Button>
                  <Button variant="ghost" onClick={() => review('flag')} data-review="flag">
                    <Flag className="h-3.5 w-3.5" />
                    Flag
                  </Button>
                </div>
              </section>
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
