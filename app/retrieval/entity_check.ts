import { inScope, type Scope } from '#app/security/scope'

/**
 * Entity pre-check (design §5): a question naming an identifier that does
 * not exist at the active commit gets a deterministic not-found answer with
 * the closest names by trigram similarity, and no model call is made.
 */
const BACKTICKED = /`([^`]+)`/g

export interface EntityCheck {
  missing: string[]
  suggestions: Record<string, string[]>
}

export function namedIdentifiers(question: string): string[] {
  return Array.from(question.matchAll(BACKTICKED), (m) => m[1].trim()).filter((id) =>
    /^[A-Za-z_$][\w$.]*$/.test(id)
  )
}

/** A backticked file path: `app.js`, `src/routes/orders.ts`, or the bare name of a nested file. */
export function namedPaths(question: string): string[] {
  return Array.from(question.matchAll(BACKTICKED), (m) => m[1].trim()).filter((p) =>
    /^[\w.@-]+(?:\/[\w.@-]+)*\.[a-z0-9]{1,6}$/i.test(p)
  )
}

export async function checkEntities(
  scope: Scope,
  commitId: string,
  question: string
): Promise<EntityCheck> {
  const identifiers = namedIdentifiers(question)
  const paths = namedPaths(question)
  const result: EntityCheck = { missing: [], suggestions: {} }
  if (identifiers.length === 0 && paths.length === 0) return result
  const facts = await inScope(scope, (trx) =>
    trx.from('repo_facts').where('commit_id', commitId).select('facts').first()
  )
  const packages = new Set(
    Object.keys(
      (facts?.facts as { lockfileVersions?: Record<string, string> })?.lockfileVersions ?? {}
    )
  )
  await inScope(scope, async (trx) => {
    // A path names a file of the index: exactly, or by its bare name (UAT 2026-09-15: the
    // suggested "What is implemented in `app.js`?" was refused as a missing symbol).
    const files = new Set<string>()
    for (const p of paths) {
      const row = await trx
        .from('files')
        .where('commit_id', commitId)
        .whereNull('ignored_by')
        .where((q) => q.where('path', p).orWhereLike('path', `%/${p}`))
        .first()
      if (row) files.add(p)
    }
    for (const identifier of identifiers) {
      if (files.has(identifier)) continue
      // A declared package is an entity of the repository too (design §6 verification table).
      if (packages.has(identifier)) continue
      const short = identifier.split('.').pop()!
      const exists = await trx
        .from('symbols')
        .where('commit_id', commitId)
        .where((q) => q.where('qualified_name', identifier).orWhere('name', short))
        .first()
      if (exists) continue
      // Not a symbol, but a path that is not a file either: `missing.js` says so like a symbol would.
      result.missing.push(identifier)
      const close = await trx.rawQuery(
        `select distinct name, similarity(name, :needle) as sim from symbols
          where commit_id = :commit and kind not in ('region', 'import') and similarity(name, :needle) > 0.2
          order by sim desc limit 3`,
        { needle: short, commit: commitId }
      )
      result.suggestions[identifier] = close.rows.map((r: { name: string }) => r.name)
    }
  })
  return result
}
