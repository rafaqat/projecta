import { codeEntities } from '#app/assistant/verification'

/**
 * What a run of withheld text tells the reader, without showing the text: its size,
 * why it was withheld, the routes and code names it mentioned — each checked against the commit
 * — and questions that would get it answered from code. Names are shown as written;
 * `inCommit` says only that the name exists at the commit.
 */
export type WithheldReason = 'connective_budget' | 'background_budget' | 'quoted_comment'

export interface WithheldSpan {
  component: 'withheld_span'
  reason: WithheldReason
  sentences: number
  characters: number
  budget: { used: number; limit: number }
  names: Array<{ name: string; inCommit: boolean }>
  routes: number
  followUps: string[]
}

export const MAX_NAMES = 12
export const MAX_FOLLOW_UPS = 3

/** A method and a path; `*` is left out so markdown emphasis after a route is not part of it. */
const ROUTE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[\w\-/:.{}]*[\w\-:}]|\/)/g

export function describeWithheld(
  text: string,
  reason: WithheldReason,
  sentences: number,
  budget: { used: number; limit: number },
  inCommit: (name: string) => boolean
): WithheldSpan {
  const routes = [...new Set([...text.matchAll(ROUTE)].map((m) => `${m[1]} ${m[2]}`))]
  // Route paths are already named with their method; their segments are not code names.
  const names = codeEntities(text).filter(
    (e) => !e.startsWith('/') && !routes.some((r) => r.includes(e))
  )
  const checked = [...routes, ...names]
    .slice(0, MAX_NAMES)
    .map((name) => ({ name, inCommit: inCommit(name) }))
  const followUps = checked
    .filter((n) => n.inCommit)
    .map((n) =>
      routes.includes(n.name) ? `What does ${n.name} do?` : `What does \`${n.name}\` do?`
    )
    .slice(0, MAX_FOLLOW_UPS)
  return {
    component: 'withheld_span',
    reason,
    sentences,
    characters: text.trim().length,
    budget,
    names: checked,
    routes: routes.length,
    followUps,
  }
}
