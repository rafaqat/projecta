import db from '@adonisjs/lucid/services/db'

/**
 * Test reset that respects the audit chain: audit_events,
 * audit_batches and audit_anchors are append-only for every role, so they
 * are never truncated. Chains are per workspace and workspaces are minted
 * fresh per test, so leftover events cannot collide.
 */
const KEEP = new Set([
  'audit_events',
  'audit_batches',
  'audit_anchors',
  'adonis_schema',
  'adonis_schema_versions',
])

export async function resetDatabase(): Promise<void> {
  // Truncation is for test databases only; a tagged run pointed at a stack database must never wipe it.
  const database = String(db.connection().getReadClient().client.config.connection?.database ?? '')
  if (!database.endsWith('_test')) {
    throw new Error(`resetDatabase refuses to truncate "${database}": not a *_test database`)
  }
  const rows = await db.rawQuery(`select tablename from pg_tables where schemaname = 'public'`)
  const tables = (rows.rows as Array<{ tablename: string }>)
    .map((r) => r.tablename)
    .filter((t) => !KEEP.has(t))
  await db.rawQuery(`truncate ${tables.map((t) => `"${t}"`).join(', ')} cascade`)
}

/**
 * Puts every BM25 index into one layout by rebuilding it. pg_textsearch
 * scores a document by the statistics of the segment it lives in, so two
 * copies of the same corpus indexed either side of a spill rank differently
 * (CI 34907722199, the injection-flag ablation after a long test job). A
 * comparison between arms calls this after indexing both.
 */
export async function settleBm25Indexes(): Promise<void> {
  const rows = await db.rawQuery(
    `select indexname from pg_indexes where schemaname = 'public' and indexdef ilike '%using bm25%'`
  )
  for (const { indexname } of rows.rows as Array<{ indexname: string }>) {
    // A spill and one merge pass were not enough: bm25_force_merge is "one bounded best-effort
    // pass" and can leave rows written at different times in different segments, each with its
    // own statistics (CI 34985649254: two arms with identical chunks ranked by whole files
    // apart, 2 runs in 6). A rebuild lays every row out in one pass from the table, so rows
    // written in any order are scored under one layout. pg_textsearch 1.4.0 has no
    // non-superuser view of the segment layout to verify convergence otherwise.
    await db.rawQuery(`reindex index ??`, [indexname])
  }
}
