import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'

/**
 * Mock OpenID Connect provider. Test profile only. It
 * implements the authorisation code flow with PKCE (S256), state and nonce,
 * signs ID tokens with RS256, and enforces the same claim shape as Entra ID
 * (`tid`, `oid`, `email`, `name`, `auth_time`). Tests choose who signs in
 * next and may tamper with the next token to exercise rejection paths.
 */
export interface MockProfile {
  oid: string
  tid: string
  email: string
  name: string
}

export interface TokenTamper {
  iss?: string
  nonce?: string
  tid?: string
  omitOid?: boolean
}

export interface MockOidcOptions {
  issuer: string
  clientId: string
  clientSecret: string
}

interface PendingCode {
  profile: MockProfile
  nonce: string
  codeChallenge: string
  redirectUri: string
  clientId: string
  authTime: number
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url')

export class MockOidcProvider {
  readonly server: Server
  private readonly privateKey
  private readonly jwk: Record<string, unknown>
  private readonly kid = randomUUID()
  private readonly codes = new Map<string, PendingCode>()
  private next: MockProfile | undefined
  private tamper: TokenTamper = {}
  readonly profiles = new Map<string, MockProfile>()

  constructor(private readonly options: MockOidcOptions) {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    this.privateKey = privateKey
    this.jwk = { ...publicKey.export({ format: 'jwk' }), kid: this.kid, use: 'sig', alg: 'RS256' }
    this.server = createServer((req, res) => this.handle(req, res))
  }

  get issuer() {
    return this.options.issuer
  }

  /** The profile the next /authorize request signs in as. */
  signInAs(profile: MockProfile) {
    this.profiles.set(profile.oid, profile)
    this.next = profile
  }

  /** Alters the next ID token so the relying party's checks can be exercised. */
  tamperNextToken(tamper: TokenTamper) {
    this.tamper = tamper
  }

  listen(port: number, host = '127.0.0.1'): Promise<void> {
    return new Promise((resolve) => this.server.listen(port, host, resolve))
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve()))
    )
  }

  private discovery() {
    const issuer = this.options.issuer
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      scopes_supported: ['openid', 'profile', 'email'],
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', this.options.issuer)
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    switch (url.pathname) {
      case '/healthz':
        return json(200, { status: 'ok' })
      case '/.well-known/openid-configuration':
        return json(200, this.discovery())
      case '/jwks':
        return json(200, { keys: [this.jwk] })
      case '/authorize':
        return this.authorize(url, res)
      case '/token':
        return this.token(req, res)
      default:
        return json(404, { error: 'not_found' })
    }
  }

  private authorize(url: URL, res: ServerResponse) {
    const q = url.searchParams
    const fail = (error: string) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error }))
    }
    const redirectUri = q.get('redirect_uri')
    const state = q.get('state')
    const nonce = q.get('nonce')
    const codeChallenge = q.get('code_challenge')
    if (q.get('response_type') !== 'code') return fail('unsupported_response_type')
    if (q.get('client_id') !== this.options.clientId) return fail('unauthorized_client')
    if (!redirectUri || !state || !nonce || !codeChallenge) return fail('invalid_request')
    if (q.get('code_challenge_method') !== 'S256') return fail('invalid_request')
    const profile = this.next ?? this.profiles.values().next().value
    if (!profile) return fail('login_required')

    const code = randomBytes(24).toString('base64url')
    this.codes.set(code, {
      profile,
      nonce,
      codeChallenge,
      redirectUri,
      clientId: this.options.clientId,
      authTime: Math.floor(Date.now() / 1000),
    })
    const target = new URL(redirectUri)
    target.searchParams.set('code', code)
    target.searchParams.set('state', state)
    res.writeHead(302, { location: target.toString() })
    res.end()
  }

  private async token(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const form = new URLSearchParams(Buffer.concat(chunks).toString())
    const fail = (error: string) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error }))
    }

    const basic = req.headers.authorization?.startsWith('Basic ')
      ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':')
      : undefined
    const clientId = form.get('client_id') ?? basic?.[0]
    const clientSecret = form.get('client_secret') ?? basic?.[1]
    if (clientId !== this.options.clientId || clientSecret !== this.options.clientSecret)
      return fail('invalid_client')
    if (form.get('grant_type') !== 'authorization_code') return fail('unsupported_grant_type')

    const pending = this.codes.get(form.get('code') ?? '')
    this.codes.delete(form.get('code') ?? '')
    if (!pending) return fail('invalid_grant')
    if (pending.redirectUri !== form.get('redirect_uri')) return fail('invalid_grant')
    const verifier = form.get('code_verifier') ?? ''
    if (createHash('sha256').update(verifier).digest('base64url') !== pending.codeChallenge)
      return fail('invalid_grant')

    const tamper = this.tamper
    this.tamper = {}
    const now = Math.floor(Date.now() / 1000)
    const claims: Record<string, unknown> = {
      iss: tamper.iss ?? this.options.issuer,
      sub: pending.profile.oid,
      aud: pending.clientId,
      exp: now + 300,
      iat: now,
      auth_time: pending.authTime,
      nonce: tamper.nonce ?? pending.nonce,
      tid: tamper.tid ?? pending.profile.tid,
      oid: pending.profile.oid,
      email: pending.profile.email,
      preferred_username: pending.profile.email,
      name: pending.profile.name,
    }
    if (tamper.omitOid) delete claims.oid

    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(
      JSON.stringify({
        access_token: randomBytes(24).toString('base64url'),
        token_type: 'Bearer',
        expires_in: 300,
        id_token: this.sign(claims),
      })
    )
  }

  private sign(claims: Record<string, unknown>): string {
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: this.kid }))
    const payload = b64url(JSON.stringify(claims))
    const signature = createSign('RSA-SHA256')
      .update(`${header}.${payload}`)
      .sign(this.privateKey)
      .toString('base64url')
    return `${header}.${payload}.${signature}`
  }
}
