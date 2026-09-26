/**
 * Comment text in evidence, and whether a sentence reproduces it (an extension of's
 * withholding). An instruction planted in a repository lives in a comment; a model that follows
 * it tends to quote it. An uncited sentence that carries a run of a comment's words verbatim is
 * withheld as `quoted_comment` — structure decides, never the ingest injection flag (:
 * the flag is a signal, not a gate). A cited sentence may quote whatever it cites.
 */

/** Consecutive words a sentence must share with one comment to count as an echo. */
export const MIN_ECHO_WORDS = 8

// Line comments and block-comment bodies in the languages the index parses; a line is taken
// whole after its marker, so a URL or code inside a comment counts as comment text.
const LINE_COMMENT = /^\s*(?:\/\/|#|--|\*|<!--|\/\*)\s?(.*?)\s*(?:\*\/|-->)?\s*$/
const TRAILING_COMMENT = /\S\s+(?:\/\/|#)\s?(.*?)\s*$/

/** The comment lines of source lines, markers stripped; empty and marker-only lines dropped. */
export function commentLines(lines: string[]): string[] {
  const out: string[] = []
  let inBlock = false
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (inBlock) {
      const end = line.indexOf('*/')
      const body = (end === -1 ? line : line.slice(0, end)).replace(/^\s*\*?\s?/, '').trim()
      if (body) out.push(body)
      if (end !== -1) inBlock = false
      continue
    }
    const whole = LINE_COMMENT.exec(line)
    if (whole) {
      if (whole[1]) out.push(whole[1])
      if (/^\s*\/\*/.test(line) && !line.includes('*/')) inBlock = true
      continue
    }
    const trailing = TRAILING_COMMENT.exec(line)
    // A `#` or `//` inside a string is not a comment; the common case (`http://`) is excluded.
    if (
      trailing &&
      trailing[1] &&
      !/https?:\/\/[^\s]*$/.test(line.slice(0, line.lastIndexOf(trailing[1])))
    )
      out.push(trailing[1])
  }
  return out
}

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

/**
 * True when `sentence` contains MIN_ECHO_WORDS consecutive words of one comment, in order.
 * Comments are joined in sequence so a run across two lines of one block still matches.
 */
export function echoesComment(
  sentence: string,
  comments: string[],
  minWords = MIN_ECHO_WORDS
): boolean {
  if (comments.length === 0) return false
  const haystack = ` ${words(sentence).join(' ')} `
  if (haystack.trim().split(' ').length < minWords) return false
  const stream = words(comments.join(' '))
  for (let i = 0; i + minWords <= stream.length; i++) {
    if (haystack.includes(` ${stream.slice(i, i + minWords).join(' ')} `)) return true
  }
  return false
}
