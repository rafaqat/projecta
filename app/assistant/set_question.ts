/**
 * A question over a whole set: "explain each endpoint" is many "what does X do"
 * questions, answered in batches whose code is in evidence. Fixed wording decides; a
 * continuation ("Explain endpoints 14 to 114") names its range.
 */
export interface SetQuestion {
  set: 'endpoints'
  /** 1-based, in table order. */
  from: number
  to: number | null
}

/**
 * The set of endpoints: named as such, or as the APIs the app implements, exposes, provides,
 * offers or has. "The APIs it uses / calls / third-party" are dependencies, not this set.
 */
const ENDPOINTS = /\b(end ?points?|routes?)\b/i
const OWN_APIS =
  /\b(apis?)\b(?=.*\b(implemented|implements?|exposed?|exposes|provided?|provides|offered?|offers|defined?|defines|available|has|have|are there|exist)\b)|\b(implemented|exposed?|provided?|defined?|available)\b(?=.*\bapis?\b)/i
const USES_APIS =
  /\b(third[- ]party|external|uses?|calls?|consumes?|integrat\w*|depends? on)\b(?=.*\bapis?\b)|\bapis?\b(?=.*\b(it|the app|we|this app|the code) (uses?|calls?|consumes?))/i
const EACH = /\b(each|every|all of them|all the|detail)\b/i
const EXPLAIN = /\b(explain|describe|detail|what (?:does|do) (?:each|every|they|all))\b/i
const RANGE = /\bend ?points?\s+(\d+)\s*(?:to|-|–)\s*(\d+)\b/i

/** Whether a question is about the app's own endpoints, however it names them (shared with the endpoint trigger). */
export function aboutOwnEndpoints(question: string): boolean {
  return ENDPOINTS.test(question) || (OWN_APIS.test(question) && !USES_APIS.test(question))
}

export function setQuestion(question: string): SetQuestion | null {
  const range = RANGE.exec(question)
  if (range) return { set: 'endpoints', from: Number(range[1]), to: Number(range[2]) }
  if (!aboutOwnEndpoints(question) || !EXPLAIN.test(question) || !EACH.test(question)) return null
  // "explain the endpoint for coupons" names one; a set is plural or "each/every".
  if (/\b(end ?point|api)\b/i.test(question) && !/\b(each|every)\b/i.test(question)) return null
  return { set: 'endpoints', from: 1, to: null }
}
