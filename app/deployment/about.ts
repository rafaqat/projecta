/**
 * "About this deployment" (WP-26): what the running system can truthfully say about
 * itself. Pure — the environment and the last recorded verdict in, the page's claims out — so
 * each rule is tested on its own.
 *
 * Two rules. An identity the deployment did not supply, or supplied malformed, is "not recorded":
 * never a blank, which reads as fine, and never a guess. And the audit chain's badge says when it
 * was verified — the page cannot verify on request, because that needs the signing key the web
 * role must not hold — so it is "verified 14 minutes ago", never "intact".
 */
export interface IdentityField {
  value: string | null
  text: string
}

const FORMATS = {
  releaseTag: { variable: 'RELEASE_TAG', pattern: /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/ },
  gitSha: { variable: 'GIT_SHA', pattern: /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/ },
  imageDigest: { variable: 'IMAGE_DIGEST', pattern: /^sha256:[0-9a-f]{64}$/ },
} as const

export function buildIdentity(
  env: Record<string, string | undefined>
): Record<keyof typeof FORMATS, IdentityField> {
  const out = {} as Record<keyof typeof FORMATS, IdentityField>
  for (const [field, { variable, pattern }] of Object.entries(FORMATS)) {
    const raw = env[variable]?.trim()
    out[field as keyof typeof FORMATS] =
      raw && pattern.test(raw) ? { value: raw, text: raw } : { value: null, text: 'not recorded' }
  }
  return out
}

export interface Verification {
  verifiedAt: Date
  ok: boolean
  keyId: string
}

export interface ChainBadge {
  state: 'verified' | 'stale' | 'failed' | 'never'
  text: string
  verifiedAt?: string
}

function ago(ms: number): string {
  const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? '' : 's'} ago`
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return unit(minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return unit(hours, 'hour')
  return unit(Math.floor(hours / 24), 'day')
}

export function chainBadge(last: Verification | null, now: Date, staleAfterMs: number): ChainBadge {
  if (!last) return { state: 'never', text: 'Audit chain never verified' }
  const age = now.getTime() - last.verifiedAt.getTime()
  const at = last.verifiedAt.toISOString()
  if (!last.ok)
    return { state: 'failed', text: `Audit chain verification failed ${ago(age)}`, verifiedAt: at }
  if (age > staleAfterMs)
    return { state: 'stale', text: `Audit chain last verified ${ago(age)} — stale`, verifiedAt: at }
  return { state: 'verified', text: `Audit chain verified ${ago(age)}`, verifiedAt: at }
}
