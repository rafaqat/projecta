interface Located {
  path: string
  span: { start: number; end: number }
}

/**
 * A retrieved candidate is "used" when a released citation lies inside it.
 * Citations name the statement block the model cited, so they seldom start
 * on the candidate's first line; containment, not equality, is the test.
 */
export function evidenceState(candidate: Located, citations: Located[]): 'used' | 'retrieved' {
  const used = citations.some(
    (c) =>
      c.path === candidate.path &&
      c.span.start >= candidate.span.start &&
      c.span.end <= candidate.span.end
  )
  return used ? 'used' : 'retrieved'
}
