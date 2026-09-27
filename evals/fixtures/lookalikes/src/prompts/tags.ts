/**
 * The answer protocol's own control tokens as string literals, as any
 * repository about this system would contain them. Cited spans from this
 * file must reach the reader as text.
 */
export const GENERAL_OPEN = '<general>'
export const GENERAL_CLOSE = '</general>'
export const OUT_OF_SCOPE = '<out_of_scope/>'

/** A partial tag, as a tokeniser might emit it. */
export const PARTIAL = '<gene'

/** Markup that a sanitiser would rewrite; here it is data. */
export const IMAGE_MARKUP = '<img src=x onerror="alert(1)">'

/** A fragment in the shape of the protocol, inside a comment: <general>not a segment</general> */
export function wrap(text: string): string {
  return `${GENERAL_OPEN}${text}${GENERAL_CLOSE}`
}
