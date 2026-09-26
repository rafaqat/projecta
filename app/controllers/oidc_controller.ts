import type { HttpContext } from '@adonisjs/core/http'
import {
  beginSignIn,
  buildLogoutUrl,
  completeSignIn,
  IdentityProviderUnavailable,
  resetOidcConfiguration,
  SignInRejected,
  type PendingSignIn,
} from '#app/auth/oidc_client'
import logger from '@adonisjs/core/services/logger'
import { findOrCreateUser } from '#app/auth/identity'
import { SESSION_LAST_SEEN_AT, SESSION_STARTED_AT } from '#app/auth/session_policy'
import { landingPathFor } from '#app/auth/landing'
import { securityEvents } from '#app/security/events/index'
import env from '#start/env'

const PENDING_KEY = 'oidc_pending'
/** The id_token, kept for `id_token_hint` at RP-initiated (provider-side) logout. */
const ID_TOKEN_KEY = 'oidc_id_token'

/**
 * The identity provider is unreachable: tell the user plainly,
 * keep the transport error and host in the server log under the request id,
 * forget the cached discovery so the next attempt retries, and answer 503
 * so clients and probes can tell it apart from a fault in this service.
 */
async function providerUnavailable(
  { request, response, inertia }: HttpContext,
  error: IdentityProviderUnavailable
) {
  const requestId = request.id() ?? ''
  resetOidcConfiguration()
  securityEvents.emit('auth.sign_in.failed', {
    issuer: env.get('OIDC_ISSUER'),
    reason: 'provider_unavailable',
    requestId,
  })
  logger.error({ request_id: requestId, reason: error.reason, err: error.cause }, error.message)
  response.status(503)
  if (request.accepts(['html', 'json']) === 'json')
    return response.json({ error: 'identity_provider_unavailable', reference: requestId })
  return inertia.render('auth/unavailable', { reference: requestId })
}

export default class OidcController {
  async start(ctx: HttpContext) {
    const { request, session, response, inertia } = ctx
    try {
      const { url, pending } = await beginSignIn()
      session.put(PENDING_KEY, pending)
      // The provider is another origin. An Inertia visit fetches over XHR, and a 302 there is
      // followed as XHR and stopped by connect-src; 409 + X-Inertia-Location is the protocol's
      // "navigate the whole window".
      if (request.header('x-inertia')) return inertia.location(url)
      return response.redirect(url)
    } catch (error) {
      if (error instanceof IdentityProviderUnavailable) return providerUnavailable(ctx, error)
      throw error
    }
  }

  async callback(ctx: HttpContext) {
    const { request, session, auth, response } = ctx
    const pending = session.pull(PENDING_KEY) as PendingSignIn | undefined
    const requestId = request.id() ?? ''
    const reject = (reason: string) => {
      securityEvents.emit('auth.sign_in.failed', {
        issuer: env.get('OIDC_ISSUER'),
        reason,
        requestId,
      })
      return response.forbidden({ error: 'sign_in_rejected' })
    }
    if (!pending || !request.input('state')) return reject('missing_state')

    try {
      const { claims, idToken } = await completeSignIn(new URL(request.completeUrl(true)), pending)
      const user = await findOrCreateUser(claims)
      await auth.use('web').login(user)
      const now = Date.now()
      session.put(SESSION_STARTED_AT, now)
      session.put(SESSION_LAST_SEEN_AT, now)
      session.put(ID_TOKEN_KEY, idToken)
      securityEvents.emit('auth.sign_in.succeeded', {
        issuer: claims.iss,
        sessionId: session.sessionId,
      })
      return response
        .redirect()
        .withQs(false)
        .toPath(await landingPathFor(user.id))
    } catch (error) {
      if (error instanceof SignInRejected) return reject(error.reason)
      if (error instanceof IdentityProviderUnavailable) return providerUnavailable(ctx, error)
      throw error
    }
  }

  async signOut({ auth, session, response, request, inertia }: HttpContext) {
    const idToken = session.get(ID_TOKEN_KEY) as string | undefined
    await auth.use('web').logout()
    session.clear()
    session.regenerate()
    // Pentest hardening: expire every app-set cookie. The session store (Postgres) is destroyed
    // server-side on commit (an empty, regenerated session deletes the prior row), so a stolen
    // pre-logout token no longer authenticates; the CSRF and theme cookies are expired too so
    // nothing this origin set survives the sign-out.
    response.clearCookie('XSRF-TOKEN')
    response.clearCookie('scheme')
    // RP-initiated (provider-side) logout ends the IdP session too, so the next
    // sign-in is a fresh Entra-style prompt rather than a silent SSO re-auth.
    // The URL is read from the provider's discovery document — Keycloak locally,
    // Entra on Azure, no code change — and is null when the provider advertises
    // no end-session endpoint (the mock), where app-side logout is all there is.
    const target = (await buildLogoutUrl(idToken)) ?? '/'
    // The end-session endpoint is another origin. An Inertia visit fetches over
    // XHR, where a 302 is blocked by connect-src, so use the protocol's
    // "navigate the whole window" (409 + X-Inertia-Location), as start() does.
    if (request.header('x-inertia')) return inertia.location(target)
    return response.redirect(target)
  }

  async me({ auth }: HttpContext) {
    const user = auth.getUserOrFail()
    return { email: user.email, fullName: user.fullName, initials: user.initials }
  }
}
