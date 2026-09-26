import type { AnswerEvent } from '#app/assistant/protocol'

/**
 * How an answer's events are laid out for the reader (AnswerCard design, 2026-09-16). Pure: the
 * Inertia client imports it, and the unit suite tests it without a browser.
 *
 * Citation chips and a sentence's verification status sit inline at the end of the sentence they
 * belong to. The evidence gate emits each released sentence's text, then its citations, then its
 * verification, so a citation or verification attaches to the text immediately before it. Inline
 * items travel inside the markdown as markers, which the renderer turns into chips and icons; the
 * marker character is stripped from model text first, so the model can never forge one.
 */
/** U+E000, a private-use character: never meaningful in model text, and stripped from it. */
export const MARKER = '\uE000'

export type Citation = Extract<AnswerEvent, { type: 'citation' }>
export type Verification = Omit<Extract<AnswerEvent, { type: 'verification' }>, 'type'>

export type AnswerBlock =
  | { kind: 'text' | 'background'; text: string }
  | { kind: 'citation'; citation: Citation }
  | { kind: 'notice'; notice: unknown }
  | { kind: 'view'; component: string; data: unknown }
  | { kind: 'policy'; rule: string }
  | { kind: 'error'; message: string }

/** An inline marker: a citation chip, a sentence's verification mark, or a chip's "calls" pills. */
export type InlineKind = 'citation' | 'citations' | 'verification' | 'pills'
export type InlinePart = string | { kind: InlineKind; ref: string }

export interface AnswerLayout {
  blocks: AnswerBlock[]
  /** This answer's citations, in the order they appear. */
  citations: Citation[]
  verifications: Map<string, Verification>
}

const MARKER_PATTERN = new RegExp(
  `${MARKER}(citations|citation|verification|pills):([^${MARKER}]+)${MARKER}`,
  'g'
)
const PILLS_MARKER = new RegExp(`${MARKER}pills:[^${MARKER}]+${MARKER}`, 'g')
const stripMarkers = (text: string) => text.split(MARKER).join('')

/** A fenced code block is open at the end of the text: inline markers there would render as code. */
const insideFence = (text: string) => (text.match(/```/g)?.length ?? 0) % 2 === 1

const TRAILING_MARKERS = new RegExp(`(?:${MARKER}[^${MARKER}]+${MARKER})+$`)

/**
 * Inserts an inline marker at the end of the last sentence, before its trailing whitespace.
 * The same citation already among the markers there is not repeated: one chip per source per
 * place (UAT 2026-09-16: eleven "1" chips after one heading). After a closing emphasis run the
 * marker is separated by a space: CommonMark closes `**Viewing Stock:**` only when whitespace or
 * punctuation follows it, and the marker is neither.
 */
function appendInline(block: { text: string }, kind: InlineKind, ref: string): boolean {
  const trailing = /\s*$/.exec(block.text)?.[0] ?? ''
  let body = block.text.slice(0, block.text.length - trailing.length)
  const marker = `${MARKER}${kind}:${ref}${MARKER}`
  const markers = TRAILING_MARKERS.exec(body)?.[0] ?? ''
  if (kind === 'citation' && markers.includes(marker)) return false
  if (!markers && /[*_~]$/.test(body)) body += ' '
  // The mark belongs to the sentence; a chip's pills are follow-ups and come last: chip, mark,
  // pills (UAT 2026-09-17: the mark trailed four pills).
  let pills = ''
  if (kind === 'verification' && markers) {
    pills = markers.match(PILLS_MARKER)?.join('') ?? ''
    body = body.slice(0, body.length - markers.length) + markers.replace(PILLS_MARKER, '')
  }
  block.text = `${body}${marker}${pills}${trailing}`
  return true
}

export function layoutAnswer(events: AnswerEvent[]): AnswerLayout {
  const blocks: AnswerBlock[] = []
  const citations: Citation[] = []
  const verifications = new Map<string, Verification>()
  for (const e of events) {
    const last = blocks[blocks.length - 1]
    if (e.type === 'text' || e.type === 'background') {
      const delta = stripMarkers(e.delta)
      if (last && last.kind === e.type) last.text += delta
      else blocks.push({ kind: e.type, text: delta })
    } else if (e.type === 'citation') {
      citations.push(e)
      if (last?.kind === 'text' && !insideFence(last.text)) {
        if (appendInline(last, 'citation', e.handle) && e.calls?.length)
          appendInline(last, 'pills', e.handle)
      } else blocks.push({ kind: 'citation', citation: e })
    } else if (e.type === 'verification') {
      verifications.set(e.sentenceId, {
        sentenceId: e.sentenceId,
        status: e.status,
        detail: e.detail,
        where: e.where,
      })
      if (last?.kind === 'text' && !insideFence(last.text))
        appendInline(last, 'verification', e.sentenceId)
    } else if (e.type === 'view' && e.component === 'scope_notice')
      blocks.push({ kind: 'notice', notice: e.data })
    else if (e.type === 'view') blocks.push({ kind: 'view', component: e.component, data: e.data })
    else if (e.type === 'policy') blocks.push({ kind: 'policy', rule: e.rule })
    else if (e.type === 'error') blocks.push({ kind: 'error', message: e.message })
  }
  // A set's progress arrives before the model's text; the reader needs it after the
  // batch, where the answer appears to stop (UAT 2026-09-17).
  const progress = blocks.filter((b) => b.kind === 'view' && b.component === 'set_progress')
  const ordered = progress.length
    ? [...blocks.filter((b) => !progress.includes(b)), ...progress]
    : blocks
  for (const block of ordered)
    if (block.kind === 'text') block.text = collapseCitationRuns(block.text)
  return { blocks: ordered, citations, verifications }
}

/**
 * How many sentences carry a source: a run of citation chips counts once, whatever its length
 * (UAT 2026-09-17: eleven sources and "3 checked" read as eight sentences unchecked). A
 * standalone citation block (after a fence) counts as one.
 */
export function citedSentences(layout: AnswerLayout): number {
  let count = 0
  for (const block of layout.blocks) {
    if (block.kind === 'citation') count++
    if (block.kind !== 'text') continue
    let inRun = false
    for (const part of splitMarkers(block.text)) {
      if (typeof part !== 'string' && part.kind === 'pills') continue // a chip's pills sit inside its run
      if (typeof part !== 'string' && part.kind === 'citations') {
        count++
        inRun = false
        continue
      }
      const isCitation = typeof part !== 'string' && part.kind === 'citation'
      if (isCitation && !inRun) count++
      inRun = isCitation
    }
  }
  return count
}

const CITATION_RUN = new RegExp(`(?:${MARKER}citation:[^${MARKER}]+${MARKER}){3,}`, 'g')

/**
 * Three or more citation chips in a row on one sentence read as a single long number (UAT
 * 2026-09-17: "3839404142…"). They collapse to one grouped chip listing every handle; two stay
 * separate. Every source still appears in the Sources rail.
 */
function collapseCitationRuns(text: string): string {
  return text.replace(CITATION_RUN, (run) => {
    const handles = [
      ...run.matchAll(new RegExp(`${MARKER}citation:([^${MARKER}]+)${MARKER}`, 'g')),
    ].map((m) => m[1])
    return `${MARKER}citations:${handles.join(',')}${MARKER}`
  })
}

/** Text and inline markers, in order. */
export function splitMarkers(text: string): InlinePart[] {
  const parts: InlinePart[] = []
  let at = 0
  for (const m of text.matchAll(MARKER_PATTERN)) {
    if (m.index! > at) parts.push(text.slice(at, m.index))
    parts.push({ kind: m[1] as InlineKind, ref: m[2] })
    at = m.index! + m[0].length
  }
  if (at < text.length) parts.push(text.slice(at))
  return parts
}

export interface VerificationSummary {
  /** Named, cited and found at the commit. */
  verified: string[]
  /** Named but not found at the commit. */
  notFound: string[]
  /** Found, but named in a sentence that cites nothing. */
  uncited: string[]
  /** A dependency's API, not repository code. */
  dependency: string[]
  /** In the commit's files, but not something the index models: the claim can't be checked. */
  notCheckable: string[]
  /** Claimed absent, and absent from the whole commit. */
  confirmedAbsent: string[]
  /** Claimed absent across the repository, but present at the commit. */
  contradicted: string[]
  /** Functions described without their body in the cited code. */
  withoutCode: string[]
  /** Named in an uncited sentence, and listed as declarations by an outline the turn showed. */
  declared: string[]
}

/** The names behind each verification outcome, de-duplicated in order, for the answer's footer. */
export function summariseVerifications(verifications: Iterable<Verification>): VerificationSummary {
  const summary: VerificationSummary = {
    verified: [],
    notFound: [],
    uncited: [],
    dependency: [],
    notCheckable: [],
    confirmedAbsent: [],
    contradicted: [],
    declared: [],
    withoutCode: [],
  }
  const add = (list: string[], names: string) => {
    for (const name of names.split(',').map((n) => n.trim()))
      if (name && !list.includes(name)) list.push(name)
  }
  for (const v of verifications) {
    if (v.status === 'verified' && v.detail.startsWith('confirmed absent:'))
      add(summary.confirmedAbsent, v.detail.slice('confirmed absent:'.length))
    else if (v.status === 'verified' && /^declared in .* \(outline\): /.test(v.detail))
      add(summary.declared, v.detail.replace(/^declared in .* \(outline\): /, ''))
    else if (v.status === 'verified') add(summary.verified, v.detail)
    else if (v.status === 'dependency')
      add(summary.dependency, v.detail.replace(/^dependency API:\s*/, ''))
    else if (v.status === 'not_checkable')
      add(summary.notCheckable, v.detail.replace(/^not checkable:\s*/, ''))
    else if (v.detail.startsWith('described without its code:'))
      add(summary.withoutCode, v.detail.slice('described without its code:'.length))
    else if (v.detail.startsWith('claimed absent, but found:'))
      add(summary.contradicted, v.detail.slice('claimed absent, but found:'.length))
    else if (v.detail.startsWith('not in repository:'))
      add(summary.notFound, v.detail.slice('not in repository:'.length))
    else add(summary.uncited, v.detail.replace(/^uncited claim naming\s*/, ''))
  }
  return summary
}

export type Callee = { name: string; path: string; line: number }

/**
 * Which "calls X" pills each citation chip carries (amendment). A callee gets a pill
 * once per answer, on the first chip that has it; never the answer's own subject (the identifier
 * of a usage view, or the function the question names); a handle cited several times keeps its
 * pills on its first chip. A callee whose body the answer also cites still gets its pill: the pill
 * is the follow-up question, which the chip is not (UAT 2026-09-17: blockUnblockUsers).
 */
export function calleePills(layout: AnswerLayout): Map<string, Callee[]> {
  const subjects = new Set<string>()
  for (const b of layout.blocks)
    if (b.kind === 'view' && b.component === 'usage_table') {
      const id = String((b.data as { identifier?: string })?.identifier ?? '')
      if (id) subjects.add(id.split('.').pop()!)
    }
  // The subject is what the question named: on "what does X do" the first citation is X's body.
  const first = layout.citations[0]
  if (first && subjects.size === 0) {
    subjects.add(first.symbol.qualifiedName)
    subjects.add(first.symbol.qualifiedName.split('.').pop()!)
  }
  const offered = new Set<string>()
  const byHandle = new Map<string, Callee[]>()
  for (const c of layout.citations) {
    if (byHandle.has(c.handle)) continue
    const pills: Callee[] = []
    for (const callee of c.calls ?? []) {
      const short = callee.name.split('.').pop()!
      if (subjects.has(callee.name) || subjects.has(short) || offered.has(callee.name)) continue
      offered.add(callee.name)
      pills.push(callee)
    }
    if (pills.length) byHandle.set(c.handle, pills)
  }
  return byHandle
}

/** A cited span, numbered by first appearance across the thread. */
export interface Source {
  n: number
  /** Unique in the thread: the turn and the handle (`sourceKey`). */
  key: string
  citation: Citation
}

/**
 * A source's identity in the thread. Citation handles (`r1`) are minted per turn, so the same
 * handle in two answers is two sources (UAT 2026-09-17: chip 1 of the second answer opened the
 * first answer's source).
 */
export const sourceKey = (turn: number, handle: string) => `${turn}:${handle}`

/** Numbers every distinct source in the order it first appears. */
export function sourcesOf(turns: Array<{ events: AnswerEvent[] }>): Map<string, Source> {
  const sources = new Map<string, Source>()
  turns.forEach((turn, i) => {
    for (const event of turn.events) {
      if (event.type !== 'citation') continue
      const key = sourceKey(i, event.handle)
      if (!sources.has(key)) sources.set(key, { n: sources.size + 1, key, citation: event })
    }
  })
  return sources
}
