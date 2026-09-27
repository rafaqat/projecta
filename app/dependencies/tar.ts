import { gunzipSync } from 'node:zlib'

/**
 * Bounded tar extraction for registry tarballs (SEC-04). Only
 * regular files under `package/` are accepted; any other entry type, a
 * path that would escape, a top-level directory other than `package/`, too
 * many entries or too many decompressed bytes rejects the whole archive.
 * `keep` decides which regular files are returned; everything else is
 * counted against the limits and discarded.
 */
export interface TarLimits {
  maxEntries: number
  maxTotalBytes: number
  maxEntryBytes: number
}

export const DEFAULT_TAR_LIMITS: TarLimits = {
  maxEntries: 5000,
  maxTotalBytes: 32 * 1024 * 1024,
  maxEntryBytes: 4 * 1024 * 1024,
}

export type TarRejection =
  | 'traversal'
  | 'not_regular_file'
  | 'outside_package'
  | 'too_many_entries'
  | 'too_large'
  | 'malformed'

export type TarResult =
  { ok: true; files: Map<string, string> } | { ok: false; reason: TarRejection }

const REGULAR = new Set(['0', '\0'])
const DIRECTORY = '5'
const PAX_HEADER = 'x'

function field(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8')
}

/** Normalises an entry path; null when it is absolute, traverses, or contains a NUL or backslash. */
export function safeEntryPath(raw: string): string | null {
  if (raw.includes('\0') || raw.includes('\\') || raw.startsWith('/')) return null
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.some((s) => s === '..')) return null
  return segments.join('/')
}

export function extractTar(
  gzipped: Buffer,
  keep: (path: string) => boolean,
  limits: TarLimits = DEFAULT_TAR_LIMITS
): TarResult {
  let archive: Buffer
  try {
    archive = gunzipSync(gzipped, { maxOutputLength: limits.maxTotalBytes + 1 })
  } catch (error) {
    return {
      ok: false,
      reason:
        (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'too_large' : 'malformed',
    }
  }
  if (archive.length > limits.maxTotalBytes) return { ok: false, reason: 'too_large' }

  const files = new Map<string, string>()
  let offset = 0
  let entries = 0
  let paxPath: string | null = null
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    offset += 512
    if (header.every((b) => b === 0)) break
    const size = Number.parseInt(field(header, 124, 12).trim() || '0', 8)
    if (!Number.isFinite(size) || size < 0) return { ok: false, reason: 'malformed' }
    const type = String.fromCharCode(header[156])
    const prefix = field(header, 257, 6) === 'ustar' ? field(header, 345, 155) : ''
    const name = paxPath ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100))
    paxPath = null
    const body = archive.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512
    if (body.length < size) return { ok: false, reason: 'malformed' }

    if (type === PAX_HEADER) {
      const match = /(?:^|\n)\d+ path=([^\n]*)/.exec(body.toString('utf8'))
      if (match) paxPath = match[1]
      continue
    }
    if (++entries > limits.maxEntries) return { ok: false, reason: 'too_many_entries' }
    const path = safeEntryPath(name)
    if (path === null) return { ok: false, reason: 'traversal' }
    if (type === DIRECTORY) continue
    if (!REGULAR.has(type)) return { ok: false, reason: 'not_regular_file' }
    if (!path.startsWith('package/')) return { ok: false, reason: 'outside_package' }
    if (size > limits.maxEntryBytes) return { ok: false, reason: 'too_large' }
    const relative = path.slice('package/'.length)
    if (keep(relative)) files.set(relative, body.toString('utf8'))
  }
  return { ok: true, files }
}
