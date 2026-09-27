import { CHUNKER_VERSION } from '#app/parse/chunker'
import { SCAN_VERSION } from '#app/parse/prose'
import { inScope, type Scope } from '#app/security/scope'
import { BULK_PRIORITY, enqueueIngest } from '#app/ingest/queue'

/**
 * Repositories whose index was cut by another chunker or scanned under another
 * extraction: the active commit's chunks do not all carry `CHUNKER_VERSION` and
 * `SCAN_VERSION` (a chunk with no recorded scan version is stale), or it has an active commit with
 * no chunks at all. An index stays that way until a forced re-derive — a normal re-ingest of an
 * indexed commit is a no-op, and until a new commit copied unchanged files forward under
 * the old chunker. `versions` names both, `chunker/scan`; a chunk with no recorded scan version
 * reads `none` (a `?` there would be a knex binding placeholder).
 */
export const CURRENT_VERSIONS = `${CHUNKER_VERSION}/${SCAN_VERSION}`
export async function staleRepositories(
  scope: Scope
): Promise<
  Array<{ id: string; handle: string; name: string; defaultRef: string; versions: string[] }>
> {
  const rows = await inScope(scope, (trx) =>
    trx
      .from('repositories as r')
      .whereNotNull('r.active_commit_id')
      .select('r.id', 'r.handle', 'r.name', 'r.default_ref')
      .select(
        trx.raw(
          `coalesce((select array_agg(distinct c.chunker_version || '/' || coalesce(c.scan_version, 'none')) from chunks c where c.commit_id = r.active_commit_id), '{}') as versions`
        )
      )
  )
  return rows
    .map((r) => ({
      id: String(r.id),
      handle: String(r.handle),
      name: String(r.name),
      defaultRef: String(r.default_ref),
      versions: (r.versions as string[]) ?? [],
    }))
    .filter((r) => r.versions.length !== 1 || r.versions[0] !== CURRENT_VERSIONS)
}

/** Queues a forced re-derive of each stale repository's default ref; returns what was queued. */
export async function reindexStale(
  scope: Scope,
  actorUserId: number
): Promise<Array<{ handle: string; name: string; versions: string[]; queued: boolean }>> {
  const out: Array<{ handle: string; name: string; versions: string[]; queued: boolean }> = []
  for (const r of await staleRepositories(scope)) {
    const id = await enqueueIngest(
      {
        workspaceId: scope.workspaceId!,
        repositoryId: r.id,
        ref: r.defaultRef,
        actorUserId,
        trigger: 'manual',
        force: true,
      },
      { priority: BULK_PRIORITY }
    )
    out.push({ handle: r.handle, name: r.name, versions: r.versions, queued: id !== null })
  }
  return out
}
