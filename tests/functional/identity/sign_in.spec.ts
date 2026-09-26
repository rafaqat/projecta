import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import type { MockOidcProvider } from '../../../services/mock-oidc/src/provider.js'
import { profile, signIn, startMockProvider } from '#tests/helpers/oidc'
import { resetDatabase } from '#tests/helpers/db'

let provider: MockOidcProvider

test.group('OIDC sign-in (SEC-11)', (group) => {
  group.setup(async () => {
    provider = await startMockProvider()
  })
  group.each.setup(() => resetDatabase())

  test('a valid token from the allowlisted tenant signs the user in and creates one account keyed by (tid, oid)', async ({
    client,
    assert,
  }) => {
    const who = profile()
    const { response, cookies } = await signIn(client, provider, who)
    response.assertStatus(302)
    const me = await client.get('/api/me').header('cookie', cookies)
    me.assertStatus(200)
    me.assertBodyContains({ email: who.email })
    const users = await db.from('users').where({ tid: who.tid, oid: who.oid })
    assert.lengthOf(users, 1)
  }).tags(['AC-WP02-01', 'wp02'])

  test('a token with a foreign tid is rejected', async ({ client, assert }) => {
    const { response } = await signIn(client, provider, profile({ tid: 'tenant-foreign' }))
    response.assertStatus(403)
    assert.equal(
      await db
        .from('users')
        .count('* as n')
        .first()
        .then((r) => Number(r!.n)),
      0
    )
  }).tags(['AC-WP02-01', 'wp02'])

  test('a token with an unlisted iss is rejected', async ({ client }) => {
    provider.tamperNextToken({ iss: 'http://127.0.0.1:9100/other' })
    const { response } = await signIn(client, provider, profile())
    response.assertStatus(403)
  }).tags(['AC-WP02-01', 'wp02'])

  test('a token with a wrong nonce is rejected', async ({ client }) => {
    provider.tamperNextToken({ nonce: 'not-the-nonce' })
    const { response } = await signIn(client, provider, profile())
    response.assertStatus(403)
  }).tags(['AC-WP02-01', 'wp02'])

  test('a callback with a missing state is rejected', async ({ client }) => {
    const { response } = await signIn(client, provider, profile(), { dropState: true })
    response.assertStatus(403)
  }).tags(['AC-WP02-01', 'wp02'])

  test('an email change on an existing (tid, oid) keeps the same account', async ({
    client,
    assert,
  }) => {
    const who = profile()
    await signIn(client, provider, who)
    await signIn(client, provider, { ...who, email: `renamed-${who.email}` })
    const users = await db.from('users').where({ tid: who.tid, oid: who.oid })
    assert.lengthOf(users, 1)
    assert.equal(users[0].email, `renamed-${who.email}`)
    assert.equal(
      await db
        .from('users')
        .count('* as n')
        .first()
        .then((r) => Number(r!.n)),
      1
    )
  }).tags(['AC-WP02-01', 'wp02'])

  test('a different oid with the same email creates a separate account', async ({
    client,
    assert,
  }) => {
    const first = profile()
    await signIn(client, provider, first)
    await signIn(client, provider, profile({ email: first.email }))
    const users = await db.from('users').where({ email: first.email })
    assert.lengthOf(users, 2)
    assert.notEqual(users[0].oid, users[1].oid)
  }).tags(['AC-WP02-01', 'wp02'])
})
