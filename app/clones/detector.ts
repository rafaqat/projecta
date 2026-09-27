import { alignTokens, type LineSpan } from '#app/clones/alignment'
import { estimatedJaccard, lshBands, minHash } from '#app/clones/minhash'
import { normalise, type Normalised, type SymbolTokens } from '#app/clones/tokens'

/**
 * Structural clone detection (design §7). Type 1 and 2 come from
 * hash equality; type 3 from shared LSH bands verified by alignment. Pairs
 * are joined into classes by union-find. Small boilerplate and framework
 * idioms are reported as repeated patterns, never as duplicates, and
 * generated, vendored and test code is excluded by default.
 */
export type CloneType = 1 | 2 | 3
export type Classification = 'duplicate' | 'pattern'

export interface CloneConfig {
  /** Below this many normalised tokens a match is boilerplate: a pattern, not a duplicate (design: about 50). */
  minTokens: number
  /** Below this nothing is reported at all. */
  patternMinTokens: number
  type3Similarity: number
  excluded: RegExp[]
}

export const DEFAULT_CLONE_CONFIG: CloneConfig = {
  minTokens: 50,
  patternMinTokens: 8,
  type3Similarity: 0.7,
  excluded: [
    /(^|\/)(test|tests|__tests__|spec|specs|vendor|vendored|node_modules|dist|build|generated)\//i,
    /\.(test|spec|d)\.[cm]?[jt]sx?$/i,
    /\.generated\./i,
  ],
}

/** The duplicate-size floor is deployment configuration; everything else is fixed by the method. */
export function cloneConfig(env: NodeJS.ProcessEnv = process.env): CloneConfig {
  const minTokens = Number(env.CLONE_MIN_TOKENS ?? DEFAULT_CLONE_CONFIG.minTokens)
  return { ...DEFAULT_CLONE_CONFIG, minTokens: Number.isFinite(minTokens) ? minTokens : 50 }
}

export interface ClonePair {
  left: string
  right: string
  type: CloneType
  similarity: number
  divergence: { left: LineSpan[]; right: LineSpan[] }
}

export interface CloneMember {
  path: string
  qualifiedName: string
  startLine: number
  endLine: number
  tokens: number
  /** Lines of this member that its class representative does not share. */
  divergence: LineSpan[]
}

export interface CloneClass {
  type: CloneType
  classification: Classification
  method: 'hash' | 'minhash+alignment'
  similarity: number
  members: CloneMember[]
}

const IDIOM_TOKENS = new Set([
  'Codable',
  'Decodable',
  'Encodable',
  'View',
  'Migration',
  'BaseSchema',
  // Android: adapter view holders and inflation, the framework's own shapes.
  'onCreateViewHolder',
  'onBindViewHolder',
  'ViewHolder',
])
/** Android annotations whose declarations repeat by design: Room, Hilt, Compose previews. */
const ANDROID_IDIOM_ANNOTATIONS =
  /^(Dao|Entity|Database|Module|Provides|InstallIn|HiltViewModel|Preview|TypeConverter)$/
const IDIOM_PATH = /(^|\/)(migrations?|routes?|controllers?)\//i

/** A request/response handler signature: `(req: Request, res: Response)` or the untyped `(req, res)` pair in the parameter list. */
function hasHandlerSignature(symbol: SymbolTokens): boolean {
  const head = symbol.tokens.slice(0, 24).map((t) => t.text)
  const open = head.indexOf('(')
  const close = head.indexOf(')')
  if (open === -1 || close === -1 || close < open) return false
  const params = head.slice(open + 1, close)
  const typed = params.includes('Request') && params.includes('Response')
  const untyped = params.includes('req') && params.includes('res')
  return typed || untyped
}

/** Framework idioms repeat by design: route handlers, Codable structs, SwiftUI bodies, migrations, Room DAOs, adapters. */
export function isIdiom(symbol: SymbolTokens): boolean {
  if (IDIOM_PATH.test(symbol.path)) return true
  if (hasHandlerSignature(symbol)) return true
  return symbol.tokens.some(
    (t, i) =>
      IDIOM_TOKENS.has(t.text) ||
      (t.text === '@' &&
        (/^(Get|Post|Put|Patch|Delete|Controller|Injectable)$/.test(
          symbol.tokens[i + 1]?.text ?? ''
        ) ||
          (symbol.path.endsWith('.kt') &&
            ANDROID_IDIOM_ANNOTATIONS.test(symbol.tokens[i + 1]?.text ?? ''))))
  )
}

class UnionFind {
  private parent = new Map<string, string>()
  find(x: string): string {
    let root = x
    while (this.parent.get(root) !== undefined && this.parent.get(root) !== root)
      root = this.parent.get(root)!
    this.parent.set(x, root)
    return root
  }
  union(a: string, b: string) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

export function detectPairs(symbols: SymbolTokens[], config = DEFAULT_CLONE_CONFIG): ClonePair[] {
  const eligible = symbols
    .filter((s) => !config.excluded.some((re) => re.test(s.path)))
    .filter((s) => s.tokens.length >= config.patternMinTokens)
    .map(normalise)
  const byName = new Map(eligible.map((s) => [key(s), s]))
  const pairs = new Map<string, ClonePair>()
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const add = (
    a: Normalised,
    b: Normalised,
    type: CloneType,
    similarity: number,
    divergence: ClonePair['divergence']
  ) => {
    const k = pairKey(key(a), key(b))
    const existing = pairs.get(k)
    if (!existing || existing.type > type)
      pairs.set(k, { left: key(a), right: key(b), type, similarity, divergence })
  }
  const empty = { left: [], right: [] }
  for (const hashField of ['type1', 'type2'] as const) {
    const groups = new Map<string, Normalised[]>()
    for (const s of eligible) groups.set(s[hashField], [...(groups.get(s[hashField]) ?? []), s])
    for (const group of groups.values())
      for (let i = 0; i < group.length; i++)
        for (let j = i + 1; j < group.length; j++)
          add(group[i], group[j], hashField === 'type1' ? 1 : 2, 1, empty)
  }
  const signatures = new Map(eligible.map((s) => [key(s), minHash(s.normalised)]))
  const buckets = new Map<string, string[]>()
  for (const s of eligible)
    for (const band of lshBands(signatures.get(key(s))!))
      buckets.set(band, [...(buckets.get(band) ?? []), key(s)])
  const tried = new Set<string>()
  for (const bucket of buckets.values())
    for (let i = 0; i < bucket.length; i++)
      for (let j = i + 1; j < bucket.length; j++) {
        const k = pairKey(bucket[i], bucket[j])
        if (pairs.has(k) || tried.has(k)) continue
        tried.add(k)
        if (
          estimatedJaccard(signatures.get(bucket[i])!, signatures.get(bucket[j])!) <
          config.type3Similarity / 2
        )
          continue
        const left = byName.get(bucket[i])!
        const right = byName.get(bucket[j])!
        const aligned = alignTokens(left, right)
        if (aligned.similarity >= config.type3Similarity)
          add(left, right, 3, aligned.similarity, aligned.divergence)
      }
  return Array.from(pairs.values()).sort(
    (a, b) => a.left.localeCompare(b.left) || a.right.localeCompare(b.right)
  )
}

export function detectClones(symbols: SymbolTokens[], config = DEFAULT_CLONE_CONFIG): CloneClass[] {
  const pairs = detectPairs(symbols, config)
  const normalisedByKey = new Map(symbols.map((s) => [key(s), normalise(s)]))
  const uf = new UnionFind()
  for (const p of pairs) uf.union(p.left, p.right)
  const groups = new Map<string, ClonePair[]>()
  for (const p of pairs) groups.set(uf.find(p.left), [...(groups.get(uf.find(p.left)) ?? []), p])
  const classes: CloneClass[] = []
  for (const group of groups.values()) {
    const names = Array.from(new Set(group.flatMap((p) => [p.left, p.right]))).sort()
    const representative = normalisedByKey.get(names[0])!
    const type = Math.max(...group.map((p) => p.type)) as CloneType
    const members: CloneMember[] = names.map((name) => {
      const s = normalisedByKey.get(name)!
      const divergence =
        s === representative || type < 3 ? [] : alignTokens(representative, s).divergence.right
      return {
        path: s.path,
        qualifiedName: s.qualifiedName,
        startLine: s.startLine,
        endLine: s.endLine,
        tokens: s.tokens.length,
        divergence,
      }
    })
    const small = members.every((m) => m.tokens < config.minTokens)
    const idiom = names.some((n) => isIdiom(normalisedByKey.get(n)!))
    classes.push({
      type,
      classification: small || idiom ? 'pattern' : 'duplicate',
      method: type === 3 ? 'minhash+alignment' : 'hash',
      similarity: Math.min(...group.map((p) => p.similarity)),
      members,
    })
  }
  // Inconsistent clones (a divergence in a near miss) rank first, then larger classes.
  return classes.sort(
    (a, b) =>
      Number(b.type === 3) - Number(a.type === 3) ||
      b.members.length - a.members.length ||
      a.members[0].path.localeCompare(b.members[0].path)
  )
}

/** LSH bands for every eligible symbol, so any citation can ask for similar code across the workspace. */
export function signatureBands(
  symbols: SymbolTokens[],
  config = DEFAULT_CLONE_CONFIG
): Array<{ symbol: SymbolTokens; bands: string[] }> {
  return symbols
    .filter((s) => !config.excluded.some((re) => re.test(s.path)))
    .filter((s) => s.tokens.length >= config.patternMinTokens)
    .map((symbol) => ({ symbol, bands: lshBands(minHash(normalise(symbol).normalised)) }))
}

export const key = (s: { path: string; qualifiedName: string }) => `${s.path}::${s.qualifiedName}`
