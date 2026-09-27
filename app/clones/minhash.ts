import { createHash } from 'node:crypto'

/**
 * MinHash over token shingles with banded LSH. Hash functions are
 * fixed affine maps over a 32-bit FNV-1a base hash, so signatures are
 * deterministic across processes and can be stored per workspace.
 */
export const SHINGLE = 3
export const SIGNATURE_SIZE = 64
export const BANDS = 16
const ROWS = SIGNATURE_SIZE / BANDS
const PRIME = 4294967311

function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

const COEFFICIENTS = Array.from({ length: SIGNATURE_SIZE }, (_, i) => {
  const seed = createHash('sha256').update(`minhash-${i}`).digest()
  return [seed.readUInt32BE(0) | 1, seed.readUInt32BE(4)] as const
})

export function shingles(tokens: string[]): Set<number> {
  const out = new Set<number>()
  if (tokens.length < SHINGLE) return out.add(fnv1a(tokens.join(' ')))
  for (let i = 0; i + SHINGLE <= tokens.length; i++)
    out.add(fnv1a(tokens.slice(i, i + SHINGLE).join(' ')))
  return out
}

export function minHash(tokens: string[]): number[] {
  const set = shingles(tokens)
  return COEFFICIENTS.map(([a, b]) => {
    let min = Number.POSITIVE_INFINITY
    for (const s of set) {
      const h = (a * s + b) % PRIME
      if (h < min) min = h
    }
    return min
  })
}

/** Band keys: two symbols sharing any band are candidates for alignment. */
export function lshBands(signature: number[]): string[] {
  const bands: string[] = []
  for (let b = 0; b < BANDS; b++) {
    const digest = createHash('sha256')
      .update(signature.slice(b * ROWS, (b + 1) * ROWS).join(','))
      .digest('hex')
    bands.push(`${b}:${digest.slice(0, 16)}`)
  }
  return bands
}

export function estimatedJaccard(a: number[], b: number[]): number {
  let same = 0
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++
  return same / a.length
}
