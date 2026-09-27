/**
 * Absence claims: which names a sentence says are absent, and how widely. A claim is
 * a name in the same clause as a negation cue, before it with at most MAX_BETWEEN words and no
 * clause verb or linking word between them, or right after it. A repository-wide cue ("there is
 * no", "could not find", "does not exist") can be contradicted by the commit; a local cue ("no",
 * "without", "does not use") only confirms, because it may be about one function.
 */
export type ClaimScope = 'repository' | 'local'

const MAX_BETWEEN = 10

const REPOSITORY_BEFORE =
  /(there (?:is|are) no|(?:cannot|can't|could not|couldn't|did not|didn't) find|found no|no (?:evidence|sign|trace) (?:of|for)|(?:do|does|did) not (?:reveal|show|contain|include) any|(?:the|this) (?:code|codebase|repository|repo|app|application|project) (?:does not|doesn't) (?:use|contain|include|define|have|implement))\s/g
const LOCAL_BEFORE =
  /\b(no|without|(?:(?:does|do|did) not|doesn't|don't|didn't) (?:use|import|include|define|implement|contain|have|rely on|depend on))\s/g
const REPOSITORY_AFTER =
  /^[`()\s]*(?:(?:is|are) not (?:used|defined|present|found|referenced) anywhere|(?:(?:does|do) not|doesn't|don't) exist)\b/
const LOCAL_AFTER =
  /^[`()\s]*(?:(?:is|are|was|were) (?:not|never) (?:used|defined|present|found|implemented|imported|called|referenced|configured)|(?:is|are) (?:absent|missing))\b/

/** Words that end the noun phrase a cue governs: a verb or a linking word means another claim. */
const BETWEEN_STOP = new Set([
  'is',
  'are',
  'was',
  'were',
  'be',
  'has',
  'have',
  'had',
  'return',
  'returns',
  'exist',
  'exists',
  'with',
  'that',
  'which',
  'who',
  'where',
  'for',
  'to',
  'from',
  'by',
])

/** A name followed by one of these is the subject of its own clause, not in a negated noun phrase. */
const SUBJECT_VERB =
  /^[`()\s]*(?:is|are|was|were|has|have|does|do|did|can|will|calls?|sends?|returns?|uses?|handles?|stores?|creates?|runs?|reads?|writes?|validates?|checks?|renders?|loads?|saves?|updates?|throws?)\b/

const HARD_BOUNDARY = /[.;:!?]\s|\b(?:but|however|whereas)\b/g
const SUBORDINATE = /\b(?:if|when|unless|once|after|before|because|although|though|while|since)\b/g

/** The clause of `text` around character `at`: [start, end). */
function clauseAround(text: string, at: number): [number, number] {
  let start = 0
  let end = text.length
  for (const m of text.matchAll(HARD_BOUNDARY)) {
    const edge = m.index! + m[0].length
    if (edge <= at) start = edge
    else if (m.index! >= at) {
      end = m.index!
      break
    }
  }
  // A subordinate clause ("if the coupon is not found,") ends at its first comma.
  for (const m of text.slice(start, at).matchAll(SUBORDINATE)) {
    const comma = text.indexOf(',', start + m.index!)
    if (comma !== -1 && comma < at) start = comma + 1
  }
  return [start, end]
}

function escape(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function absenceClaims(sentence: string, names: string[]): Map<string, ClaimScope> {
  const text = sentence.toLowerCase()
  const claims = new Map<string, ClaimScope>()
  for (const name of names) {
    const occurrence = new RegExp(
      `(?<![\\w$])\`?${escape(name.toLowerCase())}(?:\\(\\))?\`?(?![\\w$])`
    ).exec(text)
    if (!occurrence) continue
    const at = occurrence.index
    const [start, end] = clauseAround(text, at)
    const before = text.slice(start, at)
    const after = text.slice(at + occurrence[0].length, end)
    const governs = (cues: RegExp) =>
      [...before.matchAll(cues)].some((m) => {
        const between = before.slice(m.index! + m[0].length).match(/[\w'$-]+/g) ?? []
        return between.length <= MAX_BETWEEN && !between.some((w) => BETWEEN_STOP.has(w))
      })
    const subject = SUBJECT_VERB.test(after)
    if ((!subject && governs(REPOSITORY_BEFORE)) || REPOSITORY_AFTER.test(after))
      claims.set(name, 'repository')
    else if ((!subject && governs(LOCAL_BEFORE)) || LOCAL_AFTER.test(after))
      claims.set(name, 'local')
  }
  return claims
}
