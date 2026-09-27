import { MockOidcProvider } from './provider.js'

/**
 * Container entrypoint for the mock OIDC provider (test profile only). The
 * default profile is a local developer; tests drive the in-process provider
 * directly instead.
 */
const PORT = Number(process.env.PORT ?? 9000)
const ISSUER = (process.env.ISSUER ?? `http://mock-oidc:${PORT}`).replace(/\/$/, '')

const provider = new MockOidcProvider({
  issuer: ISSUER,
  clientId: process.env.OIDC_CLIENT_ID ?? 'code-intelligence-assistant',
  clientSecret: process.env.OIDC_CLIENT_SECRET ?? 'local-dev-client-secret',
})
provider.signInAs({
  oid: 'local-developer',
  tid: 'tenant-local',
  email: 'developer@example.test',
  name: 'Local Developer',
})

await provider.listen(PORT, '0.0.0.0')
console.log(JSON.stringify({ level: 'info', msg: 'mock-oidc listening', issuer: ISSUER }))
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => provider.close().then(() => process.exit(0)))
