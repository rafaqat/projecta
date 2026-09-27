/**
 * Repository URL policy (SEC-03). Decided entirely from the string:
 * only `https://`, only allowlisted hosts by exact name, no credentials, no
 * port beyond the allowlist entry, no query or fragment, and an
 * `owner/name` path. The result is the canonical clone URL.
 */
export type UrlRejection =
  | 'invalid'
  | 'scheme'
  | 'credentials'
  | 'ip_literal'
  | 'host_not_allowlisted'
  | 'port'
  | 'query_or_fragment'
  | 'path'

export type UrlPolicyResult =
  | { ok: true; url: string; host: string; owner: string; name: string }
  | { ok: false; reason: UrlRejection }

const SEGMENT = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$/
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

export function validateRepositoryUrl(input: string, allowedHosts: string[]): UrlPolicyResult {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'scheme' }
  if (url.username || url.password) return { ok: false, reason: 'credentials' }
  if (url.hostname.startsWith('[') || IPV4.test(url.hostname))
    return { ok: false, reason: 'ip_literal' }
  const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()))
  const host = url.host.toLowerCase()
  if (!allowed.has(host)) {
    return {
      ok: false,
      reason: allowed.has(url.hostname.toLowerCase()) ? 'port' : 'host_not_allowlisted',
    }
  }
  if (url.search || url.hash) return { ok: false, reason: 'query_or_fragment' }

  const segments = url.pathname.replace(/\/+$/, '').split('/').slice(1)
  if (segments.length !== 2) return { ok: false, reason: 'path' }
  const [owner, rawName] = segments
  const name = rawName.replace(/\.git$/, '')
  if (!SEGMENT.test(owner) || !SEGMENT.test(name) || owner === '..' || name === '..') {
    return { ok: false, reason: 'path' }
  }
  return { ok: true, url: `https://${host}/${owner}/${name}.git`, host, owner, name }
}
