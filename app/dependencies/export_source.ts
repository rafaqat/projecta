import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { renderSpdx } from '#app/dependencies/spdx'
import { renderCycloneDx } from '#app/dependencies/cyclonedx'
import type { DependencyFact } from '#app/dependencies/extractor'
import type { ManifestRecord } from '#app/dependencies/manifests'

/**
 * Where every dependency export reads from (WP-21, WP-22, WP-23): the session download routes and
 * the public share-link route find turns, commits and facts through these functions and nothing
 * else, so a rule added here — scoping, erasure — holds for all three. Every function takes a
 * transaction already inside a tenant scope; none opens one.
 */
export interface ExportSource {
  sha: string
  at: string
  facts: DependencyFact[]
  manifests: ManifestRecord[]
}

/**
 * The turn with this handle in this repository, as the decision drawer finds one; null
 * when it is absent, belongs to another repository, or was erased.
 */
export async function turnInRepository(
  trx: TransactionClientContract,
  repositoryId: string,
  runHandle: string
): Promise<{ id: string; commitId: string } | null> {
  const turn = (await trx
    .from('turns')
    .join('threads', 'threads.id', 'turns.thread_id')
    .where({ 'turns.run_handle': runHandle, 'threads.repository_id': repositoryId })
    .select('turns.id', 'turns.commit_id', 'turns.erased_at')
    .first()) as { id: string; commit_id: string; erased_at: Date | null } | undefined
  if (!turn || turn.erased_at) return null
  return { id: turn.id, commitId: turn.commit_id }
}

/** Whether a turn still exists unerased: a share link dies with its turn. */
export async function turnLive(trx: TransactionClientContract, turnId: string): Promise<boolean> {
  const turn = (await trx.from('turns').where('id', turnId).select('erased_at').first()) as
    { erased_at: Date | null } | undefined
  return Boolean(turn && !turn.erased_at)
}

/** The commit's dependency facts, or null when the commit is not this repository's. */
export async function exportSource(
  trx: TransactionClientContract,
  repositoryId: string,
  commitId: string
): Promise<ExportSource | null> {
  const commit = (await trx
    .from('commits')
    .where({ id: commitId, repository_id: repositoryId })
    .select('sha', 'indexed_at')
    .first()) as { sha: string; indexed_at: Date | null } | undefined
  if (!commit) return null
  const rows = await trx
    .from('dependencies')
    .where('commit_id', commitId)
    .select(
      'ecosystem',
      'name',
      'version',
      'kind',
      'importers',
      'integrity',
      'resolved',
      'manifest',
      'line'
    )
  const manifests = (await trx
    .from('manifests')
    .where('commit_id', commitId)
    .select('path', 'ecosystem', 'status', 'dependencies')) as ManifestRecord[]
  return {
    sha: commit.sha,
    // Stamped with when the commit was indexed, not when it was downloaded: the same commit
    // exports the same document, so a digest of it means something.
    at: (commit.indexed_at ?? new Date()).toISOString(),
    facts: rows.map((row) => ({
      ecosystem: row.ecosystem,
      name: row.name,
      version: row.version,
      kind: row.kind,
      importers: Array.isArray(row.importers) ? row.importers : [],
      integrity: row.integrity ?? null,
      resolved: row.resolved ?? null,
      manifest: row.manifest ?? '',
      line: row.line ?? null,
    })),
    manifests,
  }
}

/** The document, its media type and file name for one format. */
export function renderExport(
  format: 'spdx' | 'cyclonedx',
  source: ExportSource,
  repositoryName: string
): { body: string; mediaType: string; file: string } {
  const meta = { name: repositoryName, commit: source.sha, at: source.at }
  const document =
    format === 'spdx'
      ? renderSpdx(source.facts, source.manifests, meta)
      : renderCycloneDx(source.facts, source.manifests, meta)
  const stem = `${repositoryName.replace(/[^\w.-]/g, '-')}-${source.sha.slice(0, 12)}`
  return {
    body: JSON.stringify(document, null, 2) + '\n',
    mediaType: format === 'spdx' ? 'application/spdx+json' : 'application/vnd.cyclonedx+json',
    file: `${stem}.${format === 'spdx' ? 'spdx' : 'cdx'}.json`,
  }
}
