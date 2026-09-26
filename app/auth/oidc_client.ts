import * as oidc from 'openid-client'
import { testSeam } from '#app/security/ablation_switch'
import env from '#start/env'

let configuration: Promise<oidc.Configuration> | undefined

/**
 * The identity provider could not be reached or answered incorrectly: a
 * transient condition the user is told about plainly, without the internal
 * host name or the transport error, which stay in the server log.
 */
export class IdentityProviderUnavailable extends Error {
  readonly code = 'E_IDP_UNAVAILABLE'
  readonly status = 503
  constructor(
    readonly reason: 'discovery_failed' | 'token_exchange_failed',
    readonly cause: unknown
  ) {
    super(`identity provider unavailable: ${reason}`)
  }
}

const TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
])

/** A transport failure, as opposed to a protocol answer the library rejected. */
export function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) return true
  const code =
    (error as { code?: string }).code ?? (error.cause as { code?: string } | undefined)?.code
  return code !== undefined && TRANSPORT_CODES.has(code)
}

/** Forgets a cached discovery so the next sign-in retries it (tests, and after a failure). */
export function resetOidcConfiguration(): void {
  configuration = undefined
}

/**
 * Discovers the identity provider once. Plain HTTP is accepted only
 * for the mock provider in local and test environments; discovery binds the
 * issuer, so a token whose `iss` differs is rejected by the library.
 */
export function oidcConfiguration(): Promise<oidc.Configuration> {
  configuration ??= discover().catch((error) => {
    configuration = undefined
    throw error
  })
  return configuration
}

async function discover(): Promise<oidc.Configuration> {
  const seam = await testSeam<() => Promise<oidc.Configuration>>('oidcDiscovery')
  if (seam)
    return seam().catch((error) =>
      Promise.reject(new IdentityProviderUnavailable('discovery_failed', error))
    )
  const issuer = new URL(env.get('OIDC_ISSUER'))
  const insecure = issuer.protocol === 'http:' && ['local', 'test'].includes(env.get('APP_ENV'))
  return oidc
    .discovery(
      issuer,
      env.get('OIDC_CLIENT_ID'),
      env.get('OIDC_CLIENT_SECRET').release(),
      undefined,
      insecure ? { execute: [oidc.allowInsecureRequests] } : undefined
    )
    .catch((error) => Promise.reject(new IdentityProviderUnavailable('discovery_failed', error)))
}

export function redirectUri(): string {
  return new URL('/auth/callback', env.get('APP_URL')).toString()
}

export interface PendingSignIn {
  state: string
  nonce: string
  verifier: string
}

export async function beginSignIn(): Promise<{ url: string; pending: PendingSignIn }> {
  const config = await oidcConfiguration()
  const verifier = oidc.randomPKCECodeVerifier()
  const pending: PendingSignIn = { state: oidc.randomState(), nonce: oidc.randomNonce(), verifier }
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri(),
    scope: 'openid profile email',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state: pending.state,
    nonce: pending.nonce,
  })
  return { url: url.toString(), pending }
}

export interface IdentityClaims {
  iss: string
  tid: string
  oid: string
  email?: string
  name?: string
  authTime?: number
}

export interface SignInResult {
  claims: IdentityClaims
  /** The raw id_token, kept for use as `id_token_hint` at RP-initiated logout. */
  idToken: string
}

/**
 * The provider's RP-initiated logout URL (OIDC end-session), read from the
 * discovery document so it is whatever the current provider advertises —
 * Keycloak locally, Entra on Azure, with no code change. Returns null when the
 * provider advertises no `end_session_endpoint` (the mock) or discovery is
 * unavailable, so logout still completes on the app side.
 */
export async function buildLogoutUrl(idToken: string | undefined): Promise<string | null> {
  try {
    const config = await oidcConfiguration()
    const url = oidc.buildEndSessionUrl(config, {
      post_logout_redirect_uri: new URL('/', env.get('APP_URL')).toString(),
      ...(idToken ? { id_token_hint: idToken } : {}),
    })
    return url.toString()
  } catch {
    return null
  }
}

export class SignInRejected extends Error {
  constructor(readonly reason: string) {
    super(`sign-in rejected: ${reason}`)
  }
}

/**
 * Exchanges the code and validates the token: PKCE, state and nonce by the
 * library, then issuer and tenant allowlists and the immutable identity keys.
 */
export async function completeSignIn(
  currentUrl: URL,
  pending: PendingSignIn
): Promise<SignInResult> {
  const config = await oidcConfiguration()
  let claims: oidc.IDToken | undefined
  let idToken = ''
  try {
    const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: pending.verifier,
      expectedState: pending.state,
      expectedNonce: pending.nonce,
      idTokenExpected: true,
    })
    claims = tokens.claims()
    idToken = tokens.id_token ?? ''
  } catch (error) {
    if (error instanceof IdentityProviderUnavailable) throw error
    if (isTransportFailure(error))
      throw new IdentityProviderUnavailable('token_exchange_failed', error)
    throw new SignInRejected((error as Error).name)
  }
  if (!claims) throw new SignInRejected('no_id_token')

  const allowedIssuers = list(env.get('OIDC_ALLOWED_ISSUERS'))
  if (!allowedIssuers.includes(claims.iss)) throw new SignInRejected('issuer_not_allowlisted')
  const tid = typeof claims.tid === 'string' ? claims.tid : undefined
  const oid = typeof claims.oid === 'string' ? claims.oid : undefined
  if (!tid || !oid) throw new SignInRejected('identity_keys_missing')
  if (!list(env.get('OIDC_ALLOWED_TENANTS')).includes(tid))
    throw new SignInRejected('tenant_not_allowlisted')

  return {
    claims: {
      iss: claims.iss,
      tid,
      oid,
      email: typeof claims.email === 'string' ? claims.email : undefined,
      name: typeof claims.name === 'string' ? claims.name : undefined,
      authTime: typeof claims.auth_time === 'number' ? claims.auth_time : undefined,
    },
    idToken,
  }
}

function list(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
