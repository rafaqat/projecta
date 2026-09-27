/**
 * Ingest limits (SEC-19). A file outside the limits is recorded
 * with a reason and its content is not stored; the job still completes.
 */
export interface IngestLimits {
  maxFileBytes: number
  maxLineLength: number
  maxFiles: number
  maxTotalBytes: number
}

export const DEFAULT_LIMITS: IngestLimits = {
  maxFileBytes: 512 * 1024,
  maxLineLength: 5000,
  maxFiles: 20_000,
  maxTotalBytes: 200 * 1024 * 1024,
}

export type SkipReason =
  | 'binary'
  | 'file_too_large'
  | 'line_too_long'
  | 'too_many_files'
  | 'repository_too_large'
  | 'gitlink'
  /** The content carries the system-prompt canary or a planted honeytoken (WP-19, BL-05). */
  | 'canary_collision'

const SNIFF_BYTES = 8192

export function skipReasonFor(content: Buffer, limits: IngestLimits): SkipReason | null {
  if (content.length > limits.maxFileBytes) return 'file_too_large'
  // A NUL byte anywhere: Postgres text and jsonb refuse it, so a file that carries one past
  // the first kilobytes would fail the whole index (batch UAT 2026-09-15). The sniff window
  // decides quickly for real binaries; the line walk below sees the rest.
  if (content.subarray(0, SNIFF_BYTES).includes(0)) return 'binary'
  let lineStart = 0
  for (let i = 0; i <= content.length; i++) {
    if (i < content.length && content[i] === 0) return 'binary'
    if (i === content.length || content[i] === 0x0a) {
      if (i - lineStart > limits.maxLineLength) return 'line_too_long'
      lineStart = i + 1
    }
  }
  return null
}
