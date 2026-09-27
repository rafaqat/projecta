import { test } from '@japa/runner'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import env from '#start/env'
import { MemoryAnchorStore } from '#app/audit/anchors'
import { publicKeyOf, signingKeyFromSeed } from '#app/audit/signing'
import { verifyChains } from '#app/audit/verify'
import { AuditWriter } from '#app/audit/writer'
import { inScope } from '#app/security/scope'
import { resetDatabase } from '#tests/helpers/db'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'

/** The writer's connection: the audit_writer role, never the app role. */
function writerPool() {
  return new pg.Pool({
    host: env.get('DB_HOST'),
    port: env.get('DB_PORT'),
    user: 'audit_writer',
    password: 'audit',
    database: env.get('DB_DATABASE'),
    max: 2,
  })
}

/** A superuser stands in for the insider with database access (residual risk). */
function superuserPool() {
  return new pg.Pool({
    host: env.get('DB_HOST'),
    port: env.get('DB_PORT'),
    user: 'postgres',
    password: process.env.POSTGRES_PASSWORD ?? 'postgres',
    database: env.get('DB_DATABASE'),
    max: 1,
  })
}

// The configured seed, so `audit:verify` in CI can check the chains these tests leave behind.
const key = signingKeyFromSeed(process.env.AUDIT_SIGNING_SEED ?? randomBytes(32).toString('hex'))

async function outbox(ws: SeededWorkspace, event: string, payload: unknown) {
  await inScope({ userId: ws.owner.id, workspaceId: ws.workspace.id }, (trx) =>
    trx
      .table('audit_outbox')
      .insert({ workspace_id: ws.workspace.id, event, payload: JSON.stringify(payload) })
  )
}

test.group('audit chain', (group) => {
  let a: SeededWorkspace
  let pool: pg.Pool
  let insider: pg.Pool
  group.setup(async () => {
    await resetDatabase()
    ;({ a } = await seedTwoWorkspaces())
    pool = writerPool()
    insider = superuserPool()
  })
  group.teardown(async () => {
    await pool.end()
    await insider.end()
  })

  test('the application role receives a permission error on insert, update and delete against audit_events', async ({
    assert,
  }) => {
    const scope = { userId: a.owner.id, workspaceId: a.workspace.id }
    const attempts = [
      `insert into audit_events (workspace_id, seq, event, payload, occurred_at, prev_hash, hash, batch_id) values ('${a.workspace.id}', 1, 'x', '{}', now(), 'a', 'b', '${a.workspace.id}')`,
      `update audit_events set event = 'y'`,
      `delete from audit_events`,
    ]
    for (const sql of attempts) {
      const message = await inScope(scope, (trx) => trx.rawQuery(sql)).then(
        () => 'no error',
        (e: Error) => e.message
      )
      assert.match(message, /permission denied/, sql)
    }
  }).tags(['AC-WP07-03', 'wp07'])

  test('audit:verify passes on a clean chain, detects a modified event, and detects deletion after the last anchor', async ({
    assert,
  }) => {
    const anchors = new MemoryAnchorStore()
    const writer = new AuditWriter(pool, { key, anchors, anchorEvery: 3 })
    for (let i = 1; i <= 5; i++) await outbox(a, 'decision.recorded', { n: i })
    const first = await writer.consumeOnce()
    assert.equal(first.events, 5)
    assert.deepEqual(first.anchored, [a.workspace.id], 'five events exceed anchorEvery')
    const clean = await verifyChains(pool, publicKeyOf(key), anchors)
    const mine = clean.find((v) => v.workspaceId === a.workspace.id)!
    assert.isTrue(mine.ok, mine.problems.join('; '))
    assert.equal(mine.events, 5)

    // A security-relevant event anchors immediately, even below the count threshold.
    await outbox(a, 'policy.enforced', { rule: 'x' })
    const second = await writer.consumeOnce()
    assert.deepEqual(second.anchored, [a.workspace.id])
    assert.equal((await anchors.latest(a.workspace.id))!.seq, 6)

    // Modification: no role may update and the trigger blocks everyone; the insider disables it.
    await insider.query(`alter table audit_events disable trigger audit_events_no_update`)
    await insider.query(
      `update audit_events set payload = '{"n": 99}' where workspace_id = $1 and seq = 2`,
      [a.workspace.id]
    )
    const modified = await verifyChains(pool, publicKeyOf(key), anchors)
    const m = modified.find((v) => v.workspaceId === a.workspace.id)!
    assert.isFalse(m.ok)
    assert.include(m.problems.join(';'), 'modified event at seq 2')
    await insider.query(
      `update audit_events set payload = '{"n": 2}' where workspace_id = $1 and seq = 2`,
      [a.workspace.id]
    )

    // Deletion after the last anchor: seq 6 is anchored, so removing it is caught at the next verification.
    const { rows: kept } = await insider.query(
      `select * from audit_events where workspace_id = $1 and seq = 6`,
      [a.workspace.id]
    )
    await insider.query(`delete from audit_events where workspace_id = $1 and seq = 6`, [
      a.workspace.id,
    ])
    const truncated = await verifyChains(pool, publicKeyOf(key), anchors)
    const t = truncated.find((v) => v.workspaceId === a.workspace.id)!
    assert.isFalse(t.ok)
    assert.include(t.problems.join(';'), 'truncated: anchor covers seq 6, chain has 5')
    // Put the chain back so later verification of this database is clean.
    const row = kept[0]
    await insider.query(
      `insert into audit_events (workspace_id, seq, event, payload, occurred_at, prev_hash, hash, batch_id) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.workspace_id,
        row.seq,
        row.event,
        JSON.stringify(row.payload),
        row.occurred_at,
        row.prev_hash,
        row.hash,
        row.batch_id,
      ]
    )
    await insider.query(`alter table audit_events enable trigger audit_events_no_update`)
    const restored = await verifyChains(pool, publicKeyOf(key), anchors)
    assert.isTrue(restored.find((v) => v.workspaceId === a.workspace.id)!.ok)
  }).tags(['AC-WP07-04', 'wp07'])
})
