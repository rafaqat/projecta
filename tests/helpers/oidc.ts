import type { ApiClient, ApiResponse } from '@japa/api-client'
import env from '#start/env'
import { MockOidcProvider, type MockProfile } from '../../services/mock-oidc/src/provider.js'

export const MOCK_PORT = 9100

let singleton: Promise<MockOidcProvider> | undefined

/**
 * One provider per test process: the relying party caches discovery and the
 * JWKS, so a second provider with fresh keys would be rejected until the
 * cache refreshes. The process exit closes it.
 */
export function startMockProvider(): Promise<MockOidcProvider> {
  singleton ??= (async () => {
    const provider = new MockOidcProvider({
      issuer: env.get('OIDC_ISSUER'),
      clientId: env.get('OIDC_CLIENT_ID'),
      clientSecret: env.get('OIDC_CLIENT_SECRET').release(),
    })
    await provider.listen(MOCK_PORT)
    provider.server.unref()
    return provider
  })()
  return singleton
}

export function profile(overrides: Partial<MockProfile> = {}): MockProfile {
  const suffix = Math.random().toString(36).slice(2, 8)
  return {
    oid: `oid-${suffix}`,
    tid: 'tenant-local',
    email: `person-${suffix}@example.test`,
    name: `Person ${suffix}`,
    ...overrides,
  }
}

/** The raw Cookie header value for the session cookies a response set. */
export function cookieHeader(response: ApiResponse): string {
  const raw = response.headers()['set-cookie'] as unknown
  const setCookie = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : []
  return setCookie.map((line) => line.split(';')[0]).join('; ')
}

export interface SignInResult {
  response: ApiResponse
  cookies: string
}

/**
 * Drives the real authorisation code flow: app → provider → app. Returns the
 * callback response and the cookies to keep using the session.
 */
export async function signIn(
  client: ApiClient,
  provider: MockOidcProvider,
  who: MockProfile,
  options: { dropState?: boolean } = {}
): Promise<SignInResult> {
  provider.signInAs(who)
  const start = await client.get('/auth/login').redirects(0)
  start.assertStatus(302)
  const cookies = cookieHeader(start)

  const atProvider = await fetch(start.header('location') as string, { redirect: 'manual' })
  const back = new URL(atProvider.headers.get('location') as string)
  if (options.dropState) back.searchParams.delete('state')

  const response = await client
    .get(`${back.pathname}${back.search}`)
    .header('cookie', cookies)
    .redirects(0)
  return { response, cookies: cookieHeader(response) || cookies }
}

export interface Session {
  cookies: string
  xsrf: string
}

/** A signed-in session plus its CSRF token, so mutating requests reach the authorisation layer. */
export async function sessionFor(
  client: ApiClient,
  provider: MockOidcProvider,
  user: { oid: string; tid: string; email: string }
): Promise<Session> {
  const { cookies } = await signIn(client, provider, {
    oid: user.oid,
    tid: user.tid,
    email: user.email,
    name: 'x',
  })
  const page = await client.get('/').header('cookie', cookies)
  const xsrf = /XSRF-TOKEN=([^;]+)/.exec(cookieHeader(page))?.[1] ?? ''
  return { cookies: `${cookies}; XSRF-TOKEN=${xsrf}`, xsrf: decodeURIComponent(xsrf) }
}
