import { inScope, type Scope } from '#app/security/scope'

/**
 * Where a symbol is used at a commit, from the references the parser's
 * binding pass resolved at index time — never from text. A usage
 * is a call, a construction or a read of the symbol from another symbol's
 * body (or the top level of a file), resolved through scopes and imports;
 * the callees of a symbol are the same rows read the other way. The chunk
 * holding each site is returned so the sites can join the turn's evidence
 * and be cited.
 */
export interface UsageSite {
  chunkId: string | null
  path: string
  line: number
  snippet: string
  /** The symbol whose body holds the site, or null at a file's top level. */
  symbol: string | null
  kind: string
  /** `exact` | `alias` | `heuristic` (a guess by member name, badged) | `external` | `unresolved`. */
  resolution: string
  /** The definition this site resolves to; a name defined several times is grouped by it. */
  definition: { path: string; line: number } | null
}

/**
 * Calls the index could not place, reported with every usage answer and never taken for absence:
 * `named` counts those whose target name is the identifier (a caller among them is hidden);
 * `calls`/`files` count every unresolved call at the commit (a general caveat). The two are kept
 * apart: the commit-wide figure once read as hidden callers of one function (UAT 2026-09-17).
 */
export interface UnresolvedSummary {
  calls: number
  files: number
  named: { calls: number; files: number }
}

export interface Usages {
  identifier: string
  /** False when the commit was indexed before references were: a re-index fills them. */
  referencesIndexed: boolean
  definitions: Array<{ path: string; line: number; symbol: string }>
  /** Sites that use the symbol (callers). */
  usages: UsageSite[]
  /** Symbols the identifier's own body uses (callees), with the site in its body; an unresolved callee keeps its name. */
  callees: Array<{ path: string; line: number; symbol: string; kind: string; resolution: string }>
  /** Usages found before the cap; the list holds at most `limit` of them. */
  total: number
  /** Dynamic calls at the commit no tier could resolve: a caller among them cannot be listed. */
  unresolved: UnresolvedSummary
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
export const USAGES_LIMIT = 200

export async function findUsages(
  scope: Scope,
  commitId: string,
  identifier: string,
  limit = USAGES_LIMIT
): Promise<Usages> {
  if (!IDENTIFIER.test(identifier)) throw new Error(`not an identifier: ${identifier}`)
  return inScope(scope, async (trx) => {
    const definitions = await trx
      .from('symbols')
      .where({ commit_id: commitId, name: identifier })
      .whereNotIn('kind', ['region', 'import'])
      .orderBy(['path', 'start_line'])
      .select('id', 'path', 'start_line', 'qualified_name')
    const ids = definitions.map((d) => String(d.id))
    const indexed = await trx
      .from('symbol_references')
      .where('commit_id', commitId)
      .select('id')
      .first()
    const referencesIndexed = Boolean(indexed)
    if (ids.length === 0)
      return {
        identifier,
        referencesIndexed,
        definitions: [],
        usages: [],
        callees: [],
        total: 0,
        unresolved: await unresolvedAt(trx, commitId, identifier),
      }
    const incoming = await trx
      .from('symbol_references as r')
      .leftJoin('symbols as f', 'f.id', 'r.from_symbol_id')
      .where('r.commit_id', commitId)
      .whereIn('r.to_symbol_id', ids)
      .orderBy(['r.path', 'r.line'])
      .select(
        'r.path',
        'r.line',
        'r.kind',
        'r.resolution',
        'r.to_symbol_id',
        'f.qualified_name as from_symbol'
      )
    const outgoing = await trx
      .from('symbol_references as r')
      .leftJoin('symbols as t', 't.id', 'r.to_symbol_id')
      .where('r.commit_id', commitId)
      .whereIn('r.from_symbol_id', ids)
      .whereIn('r.kind', ['call', 'new', 'reference'])
      .orderBy(['r.path', 'r.line'])
      .select(
        'r.path',
        'r.line',
        'r.kind',
        'r.resolution',
        'r.target_name',
        'r.to_external',
        't.qualified_name as to_symbol'
      )
    // The chunk holding each site: its text gives the line, its id makes the site citable.
    const usages: UsageSite[] = []
    for (const row of incoming.slice(0, limit)) {
      const chunk = await trx
        .from('chunks')
        .where({ commit_id: commitId, path: row.path })
        .where('start_line', '<=', row.line)
        .where('end_line', '>=', row.line)
        .orderBy('start_line', 'desc')
        .select('id', 'start_line', 'text')
        .first()
      usages.push({
        chunkId: chunk ? String(chunk.id) : null,
        path: String(row.path),
        line: Number(row.line),
        snippet: chunk
          ? lineOf(String(chunk.text), Number(chunk.start_line), Number(row.line))
          : '',
        symbol: row.from_symbol ? String(row.from_symbol) : null,
        kind: String(row.kind),
        resolution: String(row.resolution ?? 'exact'),
        definition: (() => {
          const d = definitions.find((x) => String(x.id) === String(row.to_symbol_id))
          return d ? { path: String(d.path), line: Number(d.start_line) } : null
        })(),
      })
    }
    return {
      identifier,
      referencesIndexed,
      definitions: definitions.map((d) => ({
        path: String(d.path),
        line: Number(d.start_line),
        symbol: String(d.qualified_name),
      })),
      usages,
      callees: outgoing.map((r) => ({
        path: String(r.path),
        line: Number(r.line),
        symbol: String(r.to_symbol ?? r.to_external ?? r.target_name ?? '?'),
        kind: String(r.kind),
        resolution: String(r.resolution ?? 'exact'),
      })),
      total: incoming.length,
      unresolved: await unresolvedAt(trx, commitId, identifier),
    }
  })
}

/** Calls at the commit the index could not place, and the files they sit in. */
async function unresolvedAt(
  trx: Parameters<Parameters<typeof inScope>[1]>[0],
  commitId: string,
  identifier: string
): Promise<UnresolvedSummary> {
  const base = () =>
    trx
      .from('symbol_references')
      .where({ commit_id: commitId, resolution: 'unresolved' })
      .whereIn('kind', ['call', 'new'])
  const row = await base().countDistinct('path as files').count('* as calls').first()
  // The target's last segment is the identifier's: `helpers.showError` and `showError` both count.
  const short = identifier.split('.').pop()!.toLowerCase()
  const named = await base()
    .whereRaw("lower(split_part(coalesce(target_name, ''), '.', -1)) = ?", [short])
    .countDistinct('path as files')
    .count('* as calls')
    .first()
  return {
    calls: Number(row?.calls ?? 0),
    files: Number(row?.files ?? 0),
    named: { calls: Number(named?.calls ?? 0), files: Number(named?.files ?? 0) },
  }
}

/** A line of a chunk's code; the chunk's text carries header comment lines before the code. */
function lineOf(text: string, startLine: number, line: number): string {
  const lines = text.split('\n')
  const headerLines = lines.findIndex((l) => !l.startsWith('// '))
  return (lines[headerLines + (line - startLine)] ?? '').trim().slice(0, 200)
}
