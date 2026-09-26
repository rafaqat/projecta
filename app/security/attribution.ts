import {
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomUUID,
  type KeyObject,
} from 'node:crypto'
import canonicalize from 'canonicalize'
import { importJWK, jwtVerify, SignJWT, type CryptoKey, type JWK } from 'jose'
import env from '#start/env'

/**
 * Attribution tokens (design §8): a short-lived EdDSA JWT on every
 * provider call, audience llm-gateway, bound to the request by req_sha256
 * over the RFC 8785 canonical body and made single-use by jti. Web and
 * worker sign with different keys so the gateway can tell them apart.
 */
export type Signer = 'web' | 'worker'
export const AUDIENCE = 'llm-gateway'
export const TTL_SECONDS = 120

/**
 * The `kid` a signer stamps on its token, and the name its key takes in the
 * policy's attributionKeys map. ATTRIBUTION_KID_SUFFIX (default empty) lets a
 * second app co-exist in one gateway policy: it signs as `web<suffix>` so its
 * key sits under a distinct name beside another app's `web`, and the gateway
 * resolves each token by its kid. Key derivation is unchanged.
 */
export function attributionKid(signer: Signer): string {
  return `${signer}${process.env.ATTRIBUTION_KID_SUFFIX ?? ''}`
}

export interface AttributionClaims {
  sub: string
  workspace: string
  purpose: string
  req_sha256: string
  jti: string
}

export function requestSha256(body: unknown): string {
  const canonical = canonicalize(body)
  if (canonical === undefined) throw new TypeError('body is not canonicalisable')
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Ed25519 keys come from ATTRIBUTION_KEY_<SIGNER> (a private JWK). Local and
 * test derive a deterministic seed from APP_KEY so the stack works without
 * provisioning; production must set the variables (Key Vault on Azure).
 */
async function privateKey(signer: Signer): Promise<CryptoKey | KeyObject> {
  const configured = process.env[`ATTRIBUTION_KEY_${signer.toUpperCase()}`]
  if (configured) return (await importJWK(JSON.parse(configured) as JWK, 'EdDSA')) as CryptoKey
  if (!['local', 'test'].includes(env.get('APP_ENV'))) {
    throw new Error(`ATTRIBUTION_KEY_${signer.toUpperCase()} is required outside local and test`)
  }
  const seed = Buffer.from(
    hkdfSync('sha256', env.get('APP_KEY').release(), '', `attribution:${signer}`, 32)
  )
  // PKCS#8 wrapper for a raw Ed25519 seed.
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed])
  return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
}

export async function publicJwk(signer: Signer): Promise<JWK> {
  const key = await privateKey(signer)
  return createPublicKey(key as never).export({ format: 'jwk' }) as JWK
}

export async function mintAttributionToken(
  signer: Signer,
  claims: Omit<AttributionClaims, 'jti' | 'req_sha256'> & { body: unknown }
): Promise<{ token: string; jti: string; reqSha256: string }> {
  const jti = randomUUID()
  const reqSha256 = requestSha256(claims.body)
  const token = await new SignJWT({
    workspace: claims.workspace,
    purpose: claims.purpose,
    req_sha256: reqSha256,
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: attributionKid(signer) })
    .setSubject(claims.sub)
    .setAudience(AUDIENCE)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(await privateKey(signer))
  return { token, jti, reqSha256 }
}

/** Verification as the gateway performs it (WP-08); here for the unit tests and reconciliation. */
export async function verifyAttributionToken(
  token: string,
  signer: Signer
): Promise<AttributionClaims> {
  const key = await importJWK(await publicJwk(signer), 'EdDSA')
  const { payload } = await jwtVerify(token, key, { audience: AUDIENCE })
  return payload as unknown as AttributionClaims
}
