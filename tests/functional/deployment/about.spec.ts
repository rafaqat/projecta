import { test } from '@japa/runner'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import env from '#start/env'
import { publicKeyOf, signingKeyFromSeed } from '#app/audit/signing'
import { recordVerification } from '#app/deployment/verification'
import { resetDatabase } from '#tests/helpers/db'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'
import { signIn, startMockProvider } from '#tests/helpers/oidc'

/**
 * WP-26: the page reads its claims from the environment, the configuration and the last
 * recorded audit verdict. The verdict is written as `audit:verify` writes it — through the
 * audit_writer role — and read by the web role, which may not write it.
 */
function writerPool() {
  return new pg.Pool({
    host: env.get('DB_HOST'),
    port: env.get('DB_PORT'),
    user: 'audit_writer',
    password: 'audit',
    database: env.get('DB_DATABASE'),
    max: 1,
  })
}

async function aboutProps(client: any, cookies: string) {
  const probe = await client
    .get('/')
    .header('cookie', cookies)
    .header('x-inertia', 'true')
    .redirects(0)
  const version = String(probe.header('x-inertia-version') ?? '')
  const response = await client
    .get('/about')
    .header('cookie', cookies)
    .header('x-inertia', 'true')
    .header('x-inertia-version', version)
  response.assertStatus(200)
  return response.body().props as {
    appVersion: string
    configHash: string
    validation: { run: string | null; text: string }
    identity: Record<string, { value: string | null; text: string }>
    chain: { state: string; text: string }
  }
}

test.group('about this deployment (WP-26)', (group) => {
  let a: SeededWorkspace
  let cookies: string
  const key = signingKeyFromSeed(randomBytes(32).toString('hex'))

  group.each.setup(async () => {
    await resetDatabase()
    ;({ a } = await seedTwoWorkspaces())
  })

  const signedIn = async (client: any) => {
    const { cookies: c } = await signIn(client, await startMockProvider(), {
      oid: a.member.oid,
      tid: a.member.tid,
      email: a.member.email,
      name: 'Reader',
    })
    cookies = c
    return c
  }

  test('the page states the app version, the configHash and whether an eval run validated it', async ({
    client,
    assert,
  }) => {
    const props = await aboutProps(client, await signedIn(client))
    assert.equal(props.appVersion, env.get('APP_VERSION'))
    assert.match(props.configHash, /^[0-9a-f]{64}$/)
    assert.match(
      props.validation.text,
      props.validation.run ? /^validated by / : /^not validated by any recorded eval run$/
    )
    // The build identity this environment does not carry says so (the WP-14 seam).
    for (const field of ['releaseTag', 'gitSha', 'imageDigest'])
      if (!props.identity[field].value) assert.equal(props.identity[field].text, 'not recorded')
  }).tags(['AC-WP26-02', 'wp26'])

  test('the audit verdict audit:verify records is shown with its age, and "never" before any', async ({
    client,
    assert,
  }) => {
    const c = await signedIn(client)
    const before = await aboutProps(client, c)
    assert.equal(before.chain.state, 'never')

    const pool = writerPool()
    try {
      await recordVerification(pool, { ok: true, publicKey: publicKeyOf(key) })
      const afterPass = await aboutProps(client, c)
      const passed = afterPass.chain
      assert.equal(passed.state, 'verified')
      assert.equal(passed.text, 'Audit chain verified just now')

      await recordVerification(pool, { ok: false, publicKey: publicKeyOf(key) })
      const afterFail = await aboutProps(client, c)
      assert.equal(afterFail.chain.state, 'failed', 'the latest verdict wins')
    } finally {
      await pool.end()
    }
  }).tags(['AC-WP26-03', 'wp26'])

  test('the web role can read the verdicts and cannot write one', async ({ assert }) => {
    const { default: db } = await import('@adonisjs/lucid/services/db')
    await assert.rejects(() =>
      db
        .table('audit_verifications')
        .insert({ ok: true, key_id: 'forged', verified_at: new Date() })
    )
    await db.from('audit_verifications').count('* as n')
  }).tags(['AC-WP26-03', 'wp26'])

  test('the page requires sign-in', async ({ client, assert }) => {
    const response = await client.get('/about').redirects(0)
    assert.oneOf(response.status(), [302, 401])
    if (response.status() === 302)
      assert.include(String(response.header('location')), '/auth/login')
    void cookies
  }).tags(['AC-WP26-05', 'wp26'])
})
