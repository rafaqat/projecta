/**
 * Outbound rules (design §10). Each rule has a bounded match length so the
 * hold-back window can guarantee that no complete match is released before
 * the rule sees it. Most rules throw PolicyViolation and never rewrite text
 * (a leaked secret withholds the whole answer). The URL rule additionally
 * offers `mask` (ADR-0007): external links are a display choice, not a
 * compromise signal, so they are redacted inline and the answer is kept —
 * with `assert` re-run afterwards as the fail-closed guarantee.
 */
export class PolicyViolation extends Error {
  constructor(
    readonly ruleId: string,
    readonly severity: 'high' | 'critical' = 'high'
  ) {
    super(`policy violation: ${ruleId}`)
  }
}

export interface OutputRule {
  readonly id: string
  readonly maxMatchLength: number
  assert(text: string): void
  /**
   * Optional (ADR-0007): redact matches inline instead of withholding the whole answer, returning
   * the rewritten text and how many spans were masked. A rule that offers `mask` must still leave
   * `assert` passing on the masked text — the caller re-asserts as the fail-closed guarantee, so
   * anything `mask` could not remove (e.g. an obfuscated form) still withholds.
   */
  mask?(text: string): { text: string; masked: number }
}

const bounded = (
  id: string,
  maxMatchLength: number,
  patterns: RegExp[],
  severity: 'high' | 'critical' = 'high'
): OutputRule => ({
  id,
  maxMatchLength,
  assert(text) {
    for (const p of patterns) if (p.test(text)) throw new PolicyViolation(id, severity)
  },
})

/** The static system prompt canary and any other fixed strings that must never be echoed. */
export const canaryRule = (canaries: string[]): OutputRule => ({
  id: 'output.canary',
  maxMatchLength: Math.max(1, ...canaries.map((c) => c.length)),
  assert(text) {
    for (const c of canaries)
      if (c && text.includes(c)) throw new PolicyViolation('output.canary', 'critical')
  },
})

export const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /gh[pousr]_[A-Za-z0-9]{36,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
]
export const secretRule = (): OutputRule =>
  bounded('output.secret', 120, SECRET_PATTERNS, 'critical')

/**
 * Hosts that appear in source as identifiers, licence headers or local
 * origins, never as somewhere to send data (WP-19, BL-04): XML namespaces,
 * schema ids, licence URLs, loopback, and the RFC 2606 example domains.
 * Exact hosts only; `evil.example` and `example.com.attacker.net` still fire.
 * Loopback is exempt because code names it as an origin (`http://localhost:3000`); a link to the
 * reader's own machine carries nothing out. It is not a place an attacker can receive data.
 */
export const IDENTIFIER_URL_HOSTS = [
  'www.w3.org',
  'json-schema.org',
  'www.apache.org',
  'opensource.org',
  'www.gnu.org',
  'localhost',
  '127.0.0.1',
  'example.com',
  'example.net',
  'example.org',
]

/** What the reader sees where an external link was (ADR-0007). Carries no host, so re-asserting finds nothing. */
export const URL_MASK_TOKEN = '[external link hidden]'

/** True when a host is safe to leave in place: an identifier/licence/origin, never an exfil target. */
const isIdentifierHost = (
  host: string,
  allowedHosts: string[],
  identifierHosts: string[]
): boolean => allowedHosts.includes(host) || identifierHosts.includes(host)

/**
 * Redact markdown images and http(s) URLs whose host is neither allowed nor an identifier host,
 * replacing each with URL_MASK_TOKEN (ADR-0007). Returns the rewritten text and the count masked.
 * Operates on whatever text it is given; the caller (HoldbackStream) feeds it the normalised form
 * and re-asserts, so an obfuscated URL the regex cannot see still withholds.
 */
export function maskExternalUrls(
  text: string,
  allowedHosts: string[] = [],
  identifierHosts: string[] = IDENTIFIER_URL_HOSTS
): { text: string; masked: number } {
  let masked = 0
  // A markdown image fetches its src when rendered, whatever the scheme — mask the whole construct.
  let out = text.replace(/!\[[^\]]{0,80}\]\([^)]*\)/g, () => {
    masked++
    return URL_MASK_TOKEN
  })
  out = out.replace(/https?:\/\/[A-Za-z0-9.-]+(?:\/[^\s)\]]*)?/g, (url) => {
    const host = (url.match(/https?:\/\/([A-Za-z0-9.-]+)/)?.[1] ?? '').toLowerCase()
    if (isIdentifierHost(host, allowedHosts, identifierHosts)) return url
    masked++
    return URL_MASK_TOKEN
  })
  return { text: out, masked }
}

/** External URLs and markdown images: redacted inline (ADR-0007); `assert` re-checks fail-closed. */
export const urlRule = (
  allowedHosts: string[],
  identifierHosts: string[] = IDENTIFIER_URL_HOSTS
): OutputRule => ({
  id: 'output.url',
  maxMatchLength: 256,
  assert(text) {
    if (/!\[[^\]]{0,80}\]\(/.test(text)) throw new PolicyViolation('output.markdown_image')
    for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
      const host = m[1].toLowerCase()
      if (!isIdentifierHost(host, allowedHosts, identifierHosts))
        throw new PolicyViolation('output.url')
    }
  },
  mask(text) {
    return maskExternalUrls(text, allowedHosts, identifierHosts)
  },
})

export const rawHtmlRule = (): OutputRule =>
  bounded('output.raw_html', 64, [
    /<\s*(script|iframe|img|object|embed|svg|form)\b/i,
    /\bon(error|load|click)\s*=/i,
  ])

/**
 * Honeytokens (SEC-30): the gateway holds only HMACs of planted tokens. A
 * candidate that hashes to a token of another workspace is a P1 event.
 */
export interface HoneytokenLookup {
  (candidate: string): Promise<{ workspaceId: string } | null> | { workspaceId: string } | null
}
export const HONEYTOKEN_SHAPE = /HT-[0-9a-f]{24}/g

export function honeytokenCandidates(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(HONEYTOKEN_SHAPE), (m) => m[0])))
}
