import type { IndexVocabulary } from '#app/retrieval/router'
import { inScope, type Scope } from '#app/security/scope'
import { findAnchors, scopePolicy } from '#app/retrieval/router'

/** What the active commit knows about itself: the anchors the router looks for. */
export async function loadVocabulary(scope: Scope, commitId: string): Promise<IndexVocabulary> {
  return inScope(scope, async (trx) => {
    const symbols = await trx
      .from('symbols')
      .where('commit_id', commitId)
      .whereNotIn('kind', ['region', 'import'])
      .distinct('qualified_name')
    // Functions and methods with their lines: a description of one must cite its body.
    const callables = await trx
      .from('symbols')
      .where('commit_id', commitId)
      .whereIn('kind', ['function', 'method'])
      .select('qualified_name', 'path', 'start_line', 'end_line')
    const imports = await trx
      .from('symbols')
      .where({ commit_id: commitId, kind: 'import' })
      .distinct('name', 'parent')
    // Ignored files are files of the commit, not of the index: never suggested, never anchors.
    const paths = await trx
      .from('files')
      .where('commit_id', commitId)
      .whereNull('ignored_by')
      .select('path')
    const facts = await trx.from('repo_facts').where('commit_id', commitId).first()
    // What the commit uses most: symbols by resolved incoming references, code files
    // by declared symbols, and whether any manifest was recorded. The starter questions
    // are chosen from these, never from the alphabet.
    const mostReferenced = await trx
      .from('symbol_references as r')
      .join('symbols as s', 's.id', 'r.to_symbol_id')
      .where('r.commit_id', commitId)
      .whereNotIn('s.kind', ['region', 'import'])
      // Calls and constructions, not reads: a router read on every route line is not a hub.
      .whereIn('r.kind', ['call', 'new'])
      .groupBy('s.qualified_name')
      .orderByRaw('count(*) desc, s.qualified_name asc')
      .limit(5)
      .select('s.qualified_name')
    const busiestPaths = await trx
      .from('symbols')
      .where('commit_id', commitId)
      .whereNotIn('kind', ['region', 'import'])
      .groupBy('path')
      .orderByRaw('count(*) desc, path asc')
      .limit(5)
      .select('path')
    const manifests = await trx
      .from('manifests')
      .where('commit_id', commitId)
      .count('* as n')
      .first()
    const dependencySymbols = await trx
      .from('dependency_symbols')
      .join('dependencies', (join) =>
        join
          .on('dependencies.name', 'dependency_symbols.package')
          .andOn('dependencies.version', 'dependency_symbols.version')
      )
      .where('dependencies.commit_id', commitId)
      .distinct('dependency_symbols.name')
    const endpoints = await trx
      .from('endpoints')
      .where('commit_id', commitId)
      .select('method', 'path')
      .orderBy(['method', 'path'])
    // Every manifest's declarations, whatever the ecosystem: the lockfile alone said
    // nothing for an Android build (UAT 2026-09-15).
    const declared = await trx
      .from('dependencies')
      .where('commit_id', commitId)
      .distinct('name')
      .orderBy('name')
    const factData = (facts?.facts ?? {}) as {
      lockfileVersions?: Record<string, string>
      frameworks?: { detected: string[] }
    }
    return {
      symbols: symbols.map((s) => s.qualified_name),
      paths: paths.map((p) => p.path),
      packages: [
        ...new Set([
          ...Object.keys(factData.lockfileVersions ?? {}),
          ...declared.map((d) => String(d.name)),
        ]),
      ],
      factTerms: factData.frameworks?.detected ?? [],
      dependencySymbols: dependencySymbols.map((s) => s.name),
      endpoints: endpoints.map((e) => `${String(e.method).toUpperCase()} ${e.path}`),
      // A name imported from a package is that package's API (dependency); one imported from a
      // module of the repository — relative, or a bundler alias like Acode's "lib/settings" — is
      // repository code under that name.
      importedNames: imports
        .filter((i) => !importsPackage(String(i.parent ?? ''), factData.lockfileVersions ?? {}))
        .map((i) => i.name),
      packageImports: imports
        .filter((i) => importsPackage(String(i.parent ?? ''), factData.lockfileVersions ?? {}))
        .map((i) => i.name),
      mostReferenced: mostReferenced.map((r) => String(r.qualified_name)),
      busiestPaths: busiestPaths.map((r) => String(r.path)),
      manifests: Number(manifests?.n ?? 0),
      callables: callables.map((c) => ({
        qualifiedName: String(c.qualified_name),
        path: String(c.path),
        startLine: Number(c.start_line),
        endLine: Number(c.end_line),
      })),
    }
  })
}

function importsPackage(source: string, lockfileVersions: Record<string, string>): boolean {
  if (source.startsWith('node:')) return true
  if (source.startsWith('.') || source.startsWith('/') || source.startsWith('#')) return false
  const name = source.startsWith('@')
    ? source.split('/').slice(0, 2).join('/')
    : source.split('/')[0]
  return name in lockfileVersions
}

/**
 * Deterministic suggested questions (layer 1): built only from
 * symbols and paths that exist at the active commit, in a fixed order, so
 * they never name anything the repository does not contain.
 */
/**
 * The starter questions: first the ones the index answers without a model —
 * usages of the most-referenced symbol, the dependency table
 *, the endpoint table — then an explanation and a file, chosen by
 * use, not by alphabet (UAT 2026-09-15: `.vscode/typings/…` came first).
 * A commit indexed before those tables falls back to what it has.
 */
export function suggestedQuestions(
  vocabulary: IndexVocabulary,
  count = scopePolicy().budgets.suggestedQuestions
): string[] {
  const suggestions: string[] = []
  const referenced = vocabulary.mostReferenced ?? []
  const busiest = vocabulary.busiestPaths ?? []
  const methods = vocabulary.symbols.filter((s) => s.includes('.')).sort()
  const files = [...vocabulary.paths].filter((p) => /\.(ts|tsx|js|jsx)$/.test(p)).sort()
  if (referenced[0]) suggestions.push(`Who calls \`${referenced[0]}\`?`)
  if ((vocabulary.manifests ?? 0) > 0 || vocabulary.packages.length > 0)
    suggestions.push('Show me dependencies')
  if (vocabulary.endpoints?.length) suggestions.push('List the endpoints')
  const explain =
    referenced.find((s) => s !== referenced[0] && s.includes('.') && !s.endsWith('.constructor')) ??
    methods.find((s) => !s.endsWith('.constructor'))
  if (explain) suggestions.push(`What does \`${explain}\` do?`)
  const file = busiest[0] ?? files[0]
  if (file) suggestions.push(`What is implemented in \`${file}\`?`)
  // Without references, "Who calls" would be a question the index cannot answer (Sejima, 2026-09-16):
  // offer the map instead.
  if (!referenced[0]) suggestions.push('How is this repository organised?')
  for (const f of files) {
    if (suggestions.length >= count) break
    if (f !== file) suggestions.push(`How is \`${f}\` structured?`)
  }
  return suggestions.slice(0, count)
}

/**
 * What a pasted stack trace or log names that the index knows (WP-19, BL-09):
 * anchors found in the paste become questions, so an oversize input is
 * refused with something to ask instead of nothing. Deterministic, no model.
 */
export function suggestionsFromPaste(
  paste: string,
  vocabulary: IndexVocabulary,
  count = scopePolicy().budgets.suggestedQuestions
): string[] {
  const paths = new Set(vocabulary.paths)
  const out: string[] = []
  for (const anchor of findAnchors(paste, vocabulary)) {
    const path = vocabulary.paths.find((p) => p.toLowerCase() === anchor)
    if (path && paths.has(path)) out.push(`What is implemented in \`${path}\`?`)
    else {
      const symbol = vocabulary.symbols.find(
        (s) => s.toLowerCase() === anchor || s.split('.').pop()!.toLowerCase() === anchor
      )
      if (symbol) out.push(`What does \`${symbol}\` do?`)
    }
    if (out.length >= count) break
  }
  return out
}

const TEXT_IDENTIFIER_COMMITS = 8
const textIdentifierCache = new Map<string, Promise<ReadonlySet<string>>>()

/**
 * Every identifier in the text of the commit's non-ignored files, for the verifier: a
 * name there that the index does not model is not_checkable, not absent. A commit's files never
 * change, so the set is cached per workspace and commit, computed in the caller's scope; an empty
 * set (a scope that reads nothing) is never cached.
 */
export async function textIdentifiers(
  scope: Scope,
  commitId: string,
  options: { fresh?: boolean } = {}
): Promise<ReadonlySet<string>> {
  const key = `${scope.workspaceId}:${commitId}`
  const cached = options.fresh ? undefined : textIdentifierCache.get(key)
  if (cached) return cached
  const loading = inScope(scope, async (trx) => {
    // Identifiers, and separately the hyphenated tokens (element ids, CSS classes, route
    // segments) that a backticked name in prose may be: both sets, so `total-discount` in code
    // still yields `total` and `discount`.
    const rows = await trx.rawQuery(
      `SELECT DISTINCT m[1] AS identifier
         FROM files f
         JOIN blobs b ON b.workspace_id = f.workspace_id AND b.blob_sha = f.blob_sha,
              regexp_matches(b.content, '[A-Za-z_$][A-Za-z0-9_$]*', 'g') AS m
        WHERE f.commit_id = ? AND f.ignored_by IS NULL AND b.content IS NOT NULL
       UNION
       SELECT DISTINCT m[1]
         FROM files f
         JOIN blobs b ON b.workspace_id = f.workspace_id AND b.blob_sha = f.blob_sha,
              regexp_matches(b.content, ?, 'g') AS m
        WHERE f.commit_id = ? AND f.ignored_by IS NULL AND b.content IS NOT NULL`,
      // The hyphen pattern is bound, not inlined: knex would read its `(?:` as a binding.
      [commitId, '[A-Za-z_$][A-Za-z0-9_$]*(?:-[A-Za-z0-9_$]+)+', commitId]
    )
    return new Set<string>(rows.rows.map((r: { identifier: string }) => r.identifier))
  })
  textIdentifierCache.delete(key)
  textIdentifierCache.set(key, loading)
  const ids = await loading.catch((error) => {
    textIdentifierCache.delete(key)
    throw error
  })
  if (ids.size === 0) textIdentifierCache.delete(key)
  while (textIdentifierCache.size > TEXT_IDENTIFIER_COMMITS)
    textIdentifierCache.delete(textIdentifierCache.keys().next().value!)
  return ids
}
