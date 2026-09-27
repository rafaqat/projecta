import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import db from '@adonisjs/lucid/services/db'
import env from '#start/env'
import { openLedgerRow, updateLedgerRow, type CallContext } from '#app/audit/ledger'
import { reconcileLedgers } from '#app/audit/reconcile'
import { GatewayLedger } from '../../../services/llm-gateway/src/ledger.js'
import { resetDatabase } from '#tests/helpers/db'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'

/** The gateway writes its ledger as the gateway role, which the app cannot impersonate. */
function auditPool() {
  return new pg.Pool({
    host: env.get('DB_HOST'),
    port: env.get('DB_PORT'),
    user: 'audit_writer',
    password: 'audit',
    database: env.get('DB_DATABASE'),
    max: 1,
  })
}

function gatewayPool() {
  return new pg.Pool({
    host: env.get('DB_HOST'),
    port: env.get('DB_PORT'),
    user: 'gateway',
    password: 'gateway',
    database: env.get('DB_DATABASE'),
    max: 1,
  })
}

test.group('ledger reconciliation', (group) => {
  let a: SeededWorkspace
  let pool: pg.Pool
  let audit: pg.Pool
  let ledger: GatewayLedger
  group.setup(async () => {
    await resetDatabase()
    ;({ a } = await seedTwoWorkspaces())
    pool = gatewayPool()
    audit = auditPool()
    ledger = new GatewayLedger(pool, 'k')
  })
  group.teardown(async () => {
    await pool.end()
    await audit.end()
  })

  test('one gateway ledger row per call; reconciliation flags an injected mismatch and a token for a user with no active session', async ({
    assert,
  }) => {
    const ctx: CallContext = {
      userId: a.owner.id,
      workspaceId: a.workspace.id,
      requestId: randomUUID(),
      purpose: 'answer',
    }
    await db.table('sessions').insert({
      id: randomUUID(),
      data: '{}',
      user_id: String(a.owner.id),
      expires_at: new Date(Date.now() + 3_600_000),
    })
    // A matched call: both ledgers, completed.
    const jti = randomUUID()
    const appRow = await openLedgerRow(ctx, 'claude-haiku-4-5-20251001', jti)
    await updateLedgerRow(ctx, appRow, { inputTokens: 10, outputTokens: 5 }, 'completed')
    const gwRow = await ledger.open({
      jti,
      sub: String(a.owner.id),
      workspace: a.workspace.id,
      purpose: 'answer',
      model: 'claude-haiku-4-5-20251001',
      route: 'anthropic',
      signer: 'web',
    })
    await ledger.close(gwRow, 'completed', { input: 10, output: 5 })
    const gwRows = await pool.query(
      `select count(*)::int as n from gateway.ledger where jti = $1`,
      [jti]
    )
    assert.equal(gwRows.rows[0].n, 1)

    let report = await reconcileLedgers(audit, new Date(Date.now() - 60_000))
    assert.deepEqual(report.findings, [])

    // Injected mismatch: an app row the gateway never saw, and a gateway row with a different status.
    const orphan = randomUUID()
    await updateLedgerRow(
      ctx,
      await openLedgerRow(ctx, 'claude-haiku-4-5-20251001', orphan),
      {},
      'completed'
    )
    await ledger.close(gwRow, 'failed')
    report = await reconcileLedgers(audit, new Date(Date.now() - 60_000))
    assert.includeDeepMembers(
      report.findings.map((f) => f.kind),
      ['missing_in_gateway', 'status_mismatch']
    )

    // A gateway call for a user with no live session at that time: the bypass signature.
    const ghost = randomUUID()
    const ghostRow = await ledger.open({
      jti: ghost,
      sub: '999999',
      workspace: a.workspace.id,
      purpose: 'answer',
      model: 'm',
      route: 'anthropic',
      signer: 'web',
    })
    await ledger.close(ghostRow, 'completed')
    report = await reconcileLedgers(audit, new Date(Date.now() - 60_000))
    const ghostFindings = report.findings.filter((f) => f.jti === ghost).map((f) => f.kind)
    assert.includeMembers(ghostFindings, ['missing_in_app', 'no_active_session'])
  }).tags(['AC-WP08-08', 'wp08'])
})
