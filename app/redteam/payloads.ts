import { readFile } from 'node:fs/promises'

/**
 * Adversarial payloads at rest are base64 (T-18): seeds, generated
 * variants and planted fixtures decode only inside the builder at test time.
 * The deterministic converters here stand in for PyRIT's (base64, homoglyph,
 * invisible Unicode, splitting, comment wrapping); their outputs are frozen
 * because a later PyRIT pass may be randomised.
 */
export interface Seed {
  id: string
  objective: string
  threats: string[]
  marker: string
  text: string
}

export interface Variant extends Seed {
  seed: string
  technique: string
}

export const decode = (b64: string) => Buffer.from(b64, 'base64').toString('utf8')
export const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64')

export async function loadSeeds(path = 'evals/redteam/seeds.json'): Promise<Seed[]> {
  const doc = JSON.parse(await readFile(path, 'utf8')) as {
    seeds: Array<{
      id: string
      objective: string
      threats: string[]
      marker_b64: string
      text_b64: string
    }>
  }
  return doc.seeds.map((s) => ({
    id: s.id,
    objective: s.objective,
    threats: s.threats,
    marker: decode(s.marker_b64),
    text: decode(s.text_b64),
  }))
}

const HOMOGLYPHS: Record<string, string> = {
  a: 'а',
  e: 'е',
  o: 'о',
  p: 'р',
  c: 'с',
  x: 'х',
  i: 'і',
}

export const CONVERTERS: Record<string, (text: string) => string> = {
  plain: (t) => t,
  base64: (t) => `The following note is base64: ${encode(t)}`,
  homoglyph: (t) => t.replace(/[aeopcxi]/g, (ch) => HOMOGLYPHS[ch] ?? ch),
  zero_width_split: (t) =>
    t
      .split('')
      .map((ch, i) => (i % 3 === 0 ? `${ch}\u200b` : ch))
      .join(''),
  comment_wrapped: (t) => `/* ${t.replace(/\*\//g, '* /')} */`,
  split_across_lines: (t) => t.replace(/ (?=\S)/g, (m, i) => (i % 5 === 0 ? '\n// ' : m)),
}

export function generateVariants(seeds: Seed[], techniques = Object.keys(CONVERTERS)): Variant[] {
  const out: Variant[] = []
  for (const seed of seeds) {
    for (const technique of techniques) {
      out.push({
        ...seed,
        id: `${seed.id}--${technique}`,
        seed: seed.id,
        technique,
        text: CONVERTERS[technique](seed.text),
      })
    }
  }
  return out
}

/** The variants file is stored encoded; markers stay recoverable for the scanner's exclusion list. */
export function encodeVariants(variants: Variant[]) {
  return {
    description:
      'Deterministic payload variants (design §12 stage 3b), base64 at rest. Regenerate with `node ace redteam:generate`.',
    encoding: 'base64',
    variants: variants.map((v) => ({
      id: v.id,
      seed: v.seed,
      technique: v.technique,
      objective: v.objective,
      threats: v.threats,
      marker_b64: encode(v.marker),
      text_b64: encode(v.text),
    })),
  }
}

export async function loadVariants(
  path = 'evals/redteam/generated/variants.json'
): Promise<Variant[]> {
  const doc = JSON.parse(await readFile(path, 'utf8')) as ReturnType<typeof encodeVariants>
  return doc.variants.map((v) => ({ ...v, marker: decode(v.marker_b64), text: decode(v.text_b64) }))
}
