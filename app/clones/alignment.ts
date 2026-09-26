import type { Normalised } from '#app/clones/tokens'

/**
 * Alignment verification: a longest-common-subsequence over the
 * type 2 token streams gives the similarity and the unmatched token runs on
 * each side, which map back through token rows to line spans. Those spans
 * are the divergence: what one copy checks that the other does not.
 */
export interface LineSpan {
  start: number
  end: number
}

export interface Alignment {
  similarity: number
  divergence: { left: LineSpan[]; right: LineSpan[] }
}

const MAX_TOKENS = 4000

function spans(unmatched: number[], rows: number[]): LineSpan[] {
  const out: LineSpan[] = []
  for (const index of unmatched) {
    const row = rows[index]
    const last = out[out.length - 1]
    if (last && row <= last.end + 1) last.end = Math.max(last.end, row)
    else out.push({ start: row, end: row })
  }
  return out
}

export function alignTokens(left: Normalised, right: Normalised): Alignment {
  const a = left.normalised.slice(0, MAX_TOKENS)
  const b = right.normalised.slice(0, MAX_TOKENS)
  const n = a.length
  const m = b.length
  const width = m + 1
  // LCS table over (n+1) x (m+1); symbols are bounded by MAX_TOKENS so this stays small.
  const table = new Uint16Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const unmatchedLeft: number[] = []
  const unmatchedRight: number[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++
      j++
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) unmatchedLeft.push(i++)
    else unmatchedRight.push(j++)
  }
  while (i < n) unmatchedLeft.push(i++)
  while (j < m) unmatchedRight.push(j++)
  const longest = Math.max(n, m)
  return {
    similarity: longest === 0 ? 1 : table[0] / longest,
    divergence: {
      left: spans(
        unmatchedLeft,
        left.tokens.map((t) => t.row)
      ),
      right: spans(
        unmatchedRight,
        right.tokens.map((t) => t.row)
      ),
    },
  }
}
