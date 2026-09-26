import { createHash } from 'node:crypto'

/**
 * MinHash over token shingles (design §7, §12): the same estimator the
 * clone detector uses for near-miss candidates, reused here to deduplicate
 * normalised payloads. Signatures are k independent hash minima.
 */
export function shingles(text: string, size = 3): Set<string> {
  const tokens = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const out = new Set<string>()
  for (let i = 0; i + size <= tokens.length; i++) out.add(tokens.slice(i, i + size).join(' '))
  if (out.size === 0 && tokens.length) out.add(tokens.join(' '))
  return out
}

export function minhash(text: string, k = 64): number[] {
  const sig = new Array<number>(k).fill(Number.MAX_SAFE_INTEGER)
  for (const s of shingles(text)) {
    for (let i = 0; i < k; i++) {
      const h = createHash('sha1').update(`${i}:${s}`).digest()
      const v = h.readUInt32BE(0)
      if (v < sig[i]) sig[i] = v
    }
  }
  return sig
}

export function similarity(a: number[], b: number[]): number {
  let same = 0
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++
  return same / a.length
}

/** Keeps the first of any group whose estimated Jaccard similarity exceeds the threshold. */
export function deduplicate<T>(
  items: T[],
  text: (t: T) => string,
  threshold = 0.9
): { kept: T[]; dropped: Array<{ item: T; duplicateOf: T }> } {
  const kept: Array<{ item: T; sig: number[] }> = []
  const dropped: Array<{ item: T; duplicateOf: T }> = []
  for (const item of items) {
    const sig = minhash(text(item))
    const twin = kept.find((k) => similarity(k.sig, sig) >= threshold)
    if (twin) dropped.push({ item, duplicateOf: twin.item })
    else kept.push({ item, sig })
  }
  return { kept: kept.map((k) => k.item), dropped }
}
