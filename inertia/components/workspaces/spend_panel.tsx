import { useEffect, useState } from 'react'

interface Line {
  usd: number
  calls: number
}

interface Own {
  window: { days: number }
  note: string
  ownerSeesMembers: boolean
  totals: Line
}

interface Members {
  totals: Line
  members: Array<{ name: string; email: string; membership: string; totals: Line }>
}

const usd = (n: number) => `$${n.toFixed(2)}`

/**
 * Attributed spend on the assistant (WP-25). Everyone sees their own; an owner also sees
 * the workspace total and each member, listed by name — a plain table, with no bars, shares or
 * order by amount, because those turn cost accounting into a comparison of people. Every member
 * is told the owner can see per-member spend (the owner's decision at acceptance), and the figure
 * says it is attributed from the ledger, not the invoice.
 */
export function SpendPanel({ workspace, isOwner }: { workspace: string; isOwner: boolean }) {
  const [own, setOwn] = useState<Own | null>(null)
  const [members, setMembers] = useState<Members | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    const load = async <T,>(path: string): Promise<T | null> => {
      try {
        const response = await fetch(`/api/w/${workspace}/${path}`, {
          headers: { Accept: 'application/json' },
        })
        if (!response.ok) {
          setProblem(`Spend could not be loaded (${response.status}).`)
          return null
        }
        return (await response.json()) as T
      } catch (error) {
        setProblem(
          `Spend could not be loaded: ${error instanceof Error ? error.message : String(error)}`
        )
        return null
      }
    }
    void load<Own>('spend').then(setOwn)
    if (isOwner) void load<Members>('spend/members').then(setMembers)
  }, [workspace, isOwner])

  if (problem)
    return (
      <p className="px-2 py-2 text-[12.5px] text-danger" role="alert">
        {problem}
      </p>
    )
  if (!own) return null
  return (
    <section className="mb-3 rounded-[10px] border border-line px-3 py-2.5 text-[13px]" data-spend>
      <h2 className="m-0 mb-1.5 text-[13px] font-medium">
        Spend on the assistant, last {own.window.days} days
      </h2>
      <p className="m-0" data-spend-own>
        You: {usd(own.totals.usd)} · {own.totals.calls} {own.totals.calls === 1 ? 'call' : 'calls'}
      </p>
      {isOwner && members ? (
        <>
          <p className="m-0 mt-1" data-spend-total>
            Workspace: {usd(members.totals.usd)} · {members.totals.calls} calls
          </p>
          <table className="mt-2 w-full text-[12.5px]" data-spend-members>
            <thead>
              <tr className="text-left text-content-muted">
                <th className="py-1 font-normal">Member</th>
                <th className="py-1 text-right font-normal">Calls</th>
                <th className="py-1 text-right font-normal">Spend</th>
              </tr>
            </thead>
            <tbody>
              {members.members.map((m) => (
                <tr key={m.email} data-spend-member>
                  <td className="py-1">
                    {m.name}
                    {m.membership === 'former' ? (
                      <span className="text-content-muted"> (former member)</span>
                    ) : null}
                  </td>
                  <td className="py-1 text-right tabular-nums">{m.totals.calls}</td>
                  <td className="py-1 text-right tabular-nums">{usd(m.totals.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      <p className="m-0 mt-2 text-[12px] text-content-muted" data-spend-disclosure>
        {isOwner
          ? 'Members are told that you can see each member’s spend.'
          : 'Your workspace owner can see each member’s spend.'}
      </p>
      <p className="m-0 mt-0.5 text-[12px] text-content-muted" data-spend-note>
        {own.note}
      </p>
    </section>
  )
}
