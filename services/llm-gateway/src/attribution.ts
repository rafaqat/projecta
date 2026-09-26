import { createHash } from 'node:crypto'
import canonicalize from 'canonicalize'
import { importJWK, jwtVerify, type JWK } from 'jose'
import type { GatewayPolicy } from './policy.js'

/**
 * Attribution verification: EdDSA token for audience llm-gateway,
 * signed by the web or worker key named in the policy, bound to the request
 * body by req_sha256 and single-use by jti (replay cache bounded by expiry).
 */
export const AUDIENCE = 'llm-gateway'

export interface Verified {
  sub: string
  workspace: string
  purpose: string
  jti: string
  signer: string
}

export class AttributionError extends Error {
  constructor(readonly reason: string) {
    super(`attribution rejected: ${reason}`)
  }
}

export class ReplayCache {
  private readonly seen = new Map<string, number>()
  constructor(private readonly now: () => number = Date.now) {}
  /** Returns false when the jti was already used. */
  claim(jti: string, expiresAt: number): boolean {
    for (const [id, exp] of this.seen) if (exp < this.now()) this.seen.delete(id)
    if (this.seen.has(jti)) return false
    this.seen.set(jti, expiresAt)
    return true
  }
}

export async function verifyAttribution(
  token: string | undefined,
  body: unknown,
  policy: GatewayPolicy,
  replay: ReplayCache
): Promise<Verified> {
  if (!token) throw new AttributionError('missing')
  const header = JSON.parse(
    Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8') || '{}'
  ) as { kid?: string }
  const jwk = header.kid ? policy.attributionKeys[header.kid] : undefined
  if (!jwk) throw new AttributionError('unknown_signer')
  let payload
  try {
    ;({ payload } = await jwtVerify(token, await importJWK(jwk as JWK, 'EdDSA'), {
      audience: AUDIENCE,
    }))
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    throw new AttributionError(
      code === 'ERR_JWT_EXPIRED'
        ? 'expired'
        : code === 'ERR_JWT_CLAIM_VALIDATION_FAILED'
          ? 'wrong_audience'
          : 'invalid'
    )
  }
  const expected = createHash('sha256').update(canonicalize(body)!).digest('hex')
  if (payload.req_sha256 !== expected) throw new AttributionError('body_mismatch')
  if (typeof payload.jti !== 'string' || !replay.claim(payload.jti, (payload.exp ?? 0) * 1000))
    throw new AttributionError('replayed')
  return {
    sub: String(payload.sub),
    workspace: String(payload.workspace ?? ''),
    purpose: String(payload.purpose ?? ''),
    jti: payload.jti,
    signer: header.kid!,
  }
}
