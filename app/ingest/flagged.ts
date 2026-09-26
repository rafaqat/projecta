import { classifiableText, scanWindows } from '#app/parse/prose'

/** A flagged chunk as stored: the header-bearing text and the window the detector labelled. */
export interface FlaggedChunkRow {
  id: string
  path: string
  start_line: number
  end_line: number
  text: string
  flagged_window: number | null
}

/** What the repository page lists behind the flagged count. */
export interface FlaggedChunk {
  chunkId: string
  path: string
  start: number
  end: number
  /** The 2,000-character prose window the detector labelled; null when the flag predates the record. */
  window: number | null
  /** That window of the chunk's prose — comments and strings by file type — never its code tokens. */
  text: string
}

const HEADER = /^\/\/ path: .*\n\/\/ symbol: .*\n/

/**
 * The sentence the classifier read, recomputed from the chunk: the same extraction the scan used
 * (`classifiableText`, by file type) and the same windows, so what the page shows is what tripped
 * the detector — quoted text, never markup or code. A flag recorded before the window existed
 * shows the first window; a chunk whose prose is gone under a newer extraction shows nothing.
 */
export function flaggedChunkList(rows: FlaggedChunkRow[]): FlaggedChunk[] {
  return rows.map((row) => {
    const code = row.text.replace(HEADER, '')
    const prose = classifiableText(code, row.path)
    const windows = prose === null ? [] : scanWindows(prose)
    return {
      chunkId: String(row.id),
      path: row.path,
      start: row.start_line,
      end: row.end_line,
      window: row.flagged_window,
      text: windows[row.flagged_window ?? 0] ?? '',
    }
  })
}
