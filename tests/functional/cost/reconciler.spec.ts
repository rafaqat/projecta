import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { ledgerTotals } from '#cost/ledger_totals'
import { loadPriceTable } from '#cost/prices'
import { inScope } from '#app/security/scope'
import { runReconciliation } from '../../../services/cost-reconciler/src/run.js'
import { resetDatabase } from '#tests/helpers/db'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'

/**
 * The reconciler reads both ledgers as its own role and writes nothing
 * (AC-WP20-06): SELECT works, INSERT is refused, and a run against
 * the local ledgers produces the report with settled and provisional parts.
 */
// The same Postgres the test suite uses, as the reconciler's own role (the port differs per machine).
const RECONCILER_DB =
  process.env.COST_RECONCILER_DATABASE_URL ??
  `postgres://cost_reconciler:cost@${process.env.DB_HOST ?? '127.0.0.1'}:${process.env.DB_PORT ?? '5432'}/${process.env.DB_DATABASE ?? 'app_test'}`
let a: SeededWorkspace

async function seedUsage(
  day: string,
  inputTokens: number,
  outputTokens: number,
  model = 'claude-haiku-4-5-20251001'
) {
  await inScope({ userId: a.owner.id, workspaceId: a.workspace.id }, (trx) =>
    trx.table('llm_usage').insert({
      id: randomUUID(),
      workspace_id: a.workspace.id,
      user_id: a.owner.id,
      request_id: randomUUID(),
      turn_handle: null,
      purpose: 'answer',
      model,
      status: 'completed',
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      started_at: new Date(`${day}T10:00:00Z`),
      ended_at: new Date(`${day}T10:00:05Z`),
      jti: null,
    })
  )
}

test.group('cost reconciler against the local ledgers (WP-20)', (group) => {
  group.setup(async () => {
    await resetDatabase()
    ;({ a } = await seedTwoWorkspaces())
    await seedUsage('2026-07-01', 1_000_000, 100_000) // settled: $1.50 on the direct route
    await seedUsage('2026-09-13', 2_000_000, 0) // provisional: inside the revision lag
  })

  test('the cost_reconciler role reads both ledgers and can write neither', async ({ assert }) => {
    const client = new pg.Client({ connectionString: RECONCILER_DB })
    await client.connect()
    try {
      const usage = await client.query('select count(*)::int as n from llm_usage')
      assert.isAtLeast(usage.rows[0].n, 2)
      await client.query('select count(*) from gateway.ledger')
      for (const sql of [
        "insert into llm_usage (id, workspace_id, user_id, request_id, purpose, model, status, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, started_at) values (gen_random_uuid(), gen_random_uuid(), 1, 'r', 'answer', 'm', 'completed', 0, 0, 0, 0, now())",
        'delete from llm_usage',
        "insert into gateway.ledger (id, jti, sub, workspace_id, purpose, model, route, signer, status, started_at) values (gen_random_uuid(), 'j', 's', 'w', 'answer', 'm', 'anthropic', 'web', 'completed', now())",
      ]) {
        await assert.rejects(() => client.query(sql), /permission denied/)
      }
    } finally {
      await client.end()
    }
  }).tags(['AC-WP20-06', 'wp20'])

  test('a run prices the ledger, compares the settled window with the provider and writes the report', async ({
    assert,
  }) => {
    const client = new pg.Client({ connectionString: RECONCILER_DB })
    await client.connect()
    const query = async (sql: string, params: unknown[]) => {
      const result = await client.query(sql, params)
      return result.rows
    }
    try {
      const prices = loadPriceTable(JSON.parse(await readFile('config/prices.json', 'utf8')))
      const internal = await ledgerTotals(
        query,
        { from: '2026-07-01', to: '2026-09-13' },
        'local',
        prices
      )
      assert.deepEqual(
        internal.totals.map((t) => [t.day, t.route, t.costUsd]),
        [
          ['2026-07-01', 'anthropic', 1.5],
          ['2026-09-13', 'anthropic', 2],
        ]
      )
      assert.equal(internal.unmatchedCalls, 2, 'no gateway rows for the seeded calls')
      const dir = await mkdtemp(join(tmpdir(), 'cost-report-'))
      const report = await runReconciliation({
        query,
        prices,
        environment: 'local',
        sources: [
          {
            route: 'anthropic',
            environment: 'local',
            dailyTotals: async () => [
              {
                day: '2026-07-01',
                route: 'anthropic',
                environment: 'local',
                model: 'claude-haiku-4-5-20251001',
                costUsd: 1.9,
              },
              {
                day: '2026-09-13',
                route: 'anthropic',
                environment: 'local',
                model: 'claude-haiku-4-5-20251001',
                costUsd: 0.5,
              },
            ],
          },
        ],
        window: { from: '2026-07-01', to: '2026-09-13' },
        tolerance: { absoluteUsd: 0.05, relative: 0.02 },
        revisionLagDays: 30,
        today: new Date('2026-09-14T12:00:00Z'),
        reportPath: join(dir, 'latest.json'),
        emit: () => undefined,
      })
      assert.equal(report.settledThrough, '2026-08-15')
      assert.deepEqual(
        report.drift.map((d) => [d.day, d.varianceUsd]),
        [['2026-07-01', 0.4]]
      )
      assert.deepEqual(
        report.provisional.map((c) => c.day),
        ['2026-09-13']
      )
      const written = JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8'))
      assert.equal(written.priceVersion, prices.version)
      assert.equal(written.unmatchedCalls, 2)
      assert.lengthOf(written.drift, 1)
    } finally {
      await client.end()
    }
  }).tags(['AC-WP20-06', 'AC-WP20-02', 'wp20'])
})
