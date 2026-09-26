import { flaggedChunkList, type FlaggedChunkRow } from '#app/ingest/flagged'
import type { HttpContext } from '@adonisjs/core/http'
import { INGEST_QUEUE, enqueueIngest, ingestQueue, queuePosition } from '#app/ingest/queue'
import db from '@adonisjs/lucid/services/db'
import { securityEvents } from '#app/security/events/index'
import { inScope } from '#app/security/scope'
import { registerRepository } from '#app/repositories/register'
import { ignorePathsValidator, registerRepositoryValidator } from '#validators/repository'
import { DEFAULT_IGNORE, parseIgnoreList } from '#app/ingest/ignore'
import RepositoryTransformer from '#transformers/repository_transformer'
import WorkspaceTransformer from '#transformers/workspace_transformer'
import WorkspacePolicy from '#policies/workspace_policy'
import { assetsVersion } from '#app/assets_version'

/** What the worker wrote onto the running step; the page renders it as it is. */
interface StepProgress {
  phase: string
  done: number
  total: number
  path?: string
  counts?: {
    filesParsed: number
    filesCopied: number
    filesSkipped: Record<string, number>
    symbols: number
    chunks: number
    embeddingsComputed: number
    embeddingsCached: number
    flagged: number
    /** Where the flags are, capped at 50: a count alone cannot be looked at. */
    flaggedSpans?: Array<{ path: string; start: number; end: number }>
    endpoints: number
    dependencies: number
    cloneClasses: number
  }
}

/** Timestamps cross to the page as ISO strings or null. */
const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : value ? String(value) : null

export default class RepositoriesController {
  async show({ auth, bouncer, scope, inertia }: HttpContext) {
    const user = auth.getUserOrFail()
    return inertia.render('repositories/show', {
      ingest: await this.ingestView(user.id, scope.workspace.id, scope.repository!.id, {
        withDefaults: false,
      }),
      canManage: await bouncer.with(WorkspacePolicy).allows('manage', scope.workspace),
      workspace: WorkspaceTransformer.transform(scope.workspace),
      repository: RepositoryTransformer.transform(scope.repository!),
      assetsVersion: assetsVersion(),
    })
  }

  /** Files of the active commit with the injection badge: a boolean, never a score (SEC-28). */
  async files({ auth, scope }: HttpContext) {
    const user = auth.getUserOrFail()
    const repository = scope.repository!
    if (!repository.activeCommitId) return { files: [] }
    const rows = await inScope({ userId: user.id, workspaceId: scope.workspace.id }, (trx) =>
      trx
        .from('files')
        .leftJoin('chunks', function () {
          this.on('chunks.commit_id', 'files.commit_id').andOn('chunks.path', 'files.path')
        })
        .where('files.commit_id', repository.activeCommitId!)
        .groupBy('files.path', 'files.change')
        .select('files.path', 'files.change')
        .select(
          trx.raw('bool_or(coalesce(chunks.injection_suspected, false)) as injection_suspected')
        )
        .select(trx.raw('count(chunks.id)::int as chunks'))
        .orderBy('files.path')
    )
    return {
      files: rows.map((r) => ({
        path: r.path,
        change: r.change,
        chunks: r.chunks,
        injectionSuspected: Boolean(r.injection_suspected),
      })),
    }
  }

  /**
   * The code of one declaration the answer named but did not cite: the file pane opens it
   * from its own source, read-only, without spending a model turn. Scoped to the workspace and the
   * repository's active commit; the blob content already has secrets redacted, and the
   * smallest symbol containing the line is returned so a nested declaration reads as itself.
   */
  async declaration({ auth, scope, request, response }: HttpContext) {
    const user = auth.getUserOrFail()
    const repository = scope.repository!
    const path = String(request.input('path') ?? '')
    const line = Number(request.input('line'))
    if (!repository.activeCommitId || !path || !Number.isInteger(line))
      return response.badRequest({ error: 'path and line required' })
    const row = await inScope({ userId: user.id, workspaceId: scope.workspace.id }, (trx) =>
      trx
        .from('symbols as s')
        .join('blobs as b', (join) => {
          join.on('b.blob_sha', 's.blob_sha').andOn('b.workspace_id', 's.workspace_id')
        })
        .where('s.commit_id', repository.activeCommitId!)
        .where('s.path', path)
        .where('s.start_line', '<=', line)
        .where('s.end_line', '>=', line)
        .select('s.qualified_name', 's.start_line', 's.end_line', 'b.content', 'b.redacted')
        .orderByRaw('(s.end_line - s.start_line) asc')
        .first()
    )
    if (!row || row.content === null) return response.notFound({ error: 'not_found' })
    const start = Number(row.start_line)
    const end = Number(row.end_line)
    return {
      path,
      qualifiedName: String(row.qualified_name),
      start,
      end,
      redacted: Boolean(row.redacted),
      lines: String(row.content)
        .split('\n')
        .slice(start - 1, end),
    }
  }

  /**
   * Registration (SEC-03): the URL policy decides before any
   * network call; a rejected URL is a security event and a 422, never a fetch.
   */
  async store({ auth, scope, request, response }: HttpContext) {
    const user = auth.getUserOrFail()
    const input = await request.validateUsing(registerRepositoryValidator)
    const result = await registerRepository(
      { userId: user.id, workspaceId: scope.workspace.id, requestId: request.id() ?? '' },
      input
    )
    if (!result.ok)
      return response.unprocessableEntity({
        errors: [{ field: result.field, message: result.message }],
      })
    return response.status(result.created ? 201 : 200).json({
      handle: result.handle,
      webhookHandle: result.webhookHandle,
      url: result.url,
      status: 'registered',
    })
  }

  /** The repository page's view of ingestion: status, the last failure, steps of the latest run, and whether a job waits. */
  private async ingestView(
    userId: number,
    workspaceId: string,
    repositoryId: string,
    { withDefaults = true }: { withDefaults?: boolean } = {}
  ) {
    const scope = { userId, workspaceId }
    const repository = await inScope(scope, (trx) =>
      trx
        .from('repositories')
        .where({ id: repositoryId, workspace_id: workspaceId })
        .select('status', 'status_detail', 'default_ref', 'active_commit_id', 'ignore_paths')
        .first()
    )
    const ignorePaths = (repository?.ignore_paths as string[] | null) ?? null
    const latest = await inScope(scope, (trx) =>
      trx
        .from('ingest_steps')
        .where('repository_id', repositoryId)
        .orderBy('started_at', 'desc')
        .select('commit_sha')
        .first()
    )
    const steps = latest
      ? await inScope(scope, (trx) =>
          trx
            .from('ingest_steps')
            .where({ repository_id: repositoryId, commit_sha: latest.commit_sha })
            .orderBy('started_at')
            .select('step', 'status', 'started_at', 'finished_at', 'progress')
        )
      : []
    const active = repository?.active_commit_id
      ? await inScope(scope, (trx) =>
          trx
            .from('commits')
            .where('id', repository.active_commit_id)
            .select('sha', 'indexed_at')
            .first()
        )
      : null
    // The queue's schema exists once pg-boss has started (idempotent; the first page view
    // on a fresh database would otherwise read a table that is not there yet).
    await ingestQueue()
    // pg-boss rows carry no workspace column: the filter is on the job's own payload.
    const waiting = await db.rawQuery(
      `select state, retry_count from pgboss.job
        where name = :queue and state in ('created', 'retry', 'active')
          and data->>'workspaceId' = :workspace and data->>'repositoryId' = :repository
        order by created_on desc limit 1`,
      { queue: INGEST_QUEUE, workspace: workspaceId, repository: repositoryId }
    )
    const job = waiting.rows[0] as { state: string; retry_count: number } | undefined
    // The file list is for the indexing view only: present while no commit is active or a
    // run is pending, in the order the indexer walks them (path).
    const pending =
      !repository?.active_commit_id || Boolean(job) || repository.status === 'indexing'
    const files =
      pending && latest
        ? await inScope(scope, (trx) =>
            trx
              .from('files')
              .join('commits', 'commits.id', 'files.commit_id')
              .leftJoin('blobs', function () {
                this.on('blobs.blob_sha', 'files.blob_sha').andOn(
                  'blobs.workspace_id',
                  'files.workspace_id'
                )
              })
              .where({ 'commits.repository_id': repositoryId, 'commits.sha': latest.commit_sha })
              .orderByRaw('files.path collate "C"')
              .select('files.path', 'files.change', 'files.ignored_by', 'blobs.skip_reason')
          )
        : null
    return {
      // Page props carry only a custom list (the defaults are not snapshot material); the
      // status endpoint always carries the list in force.
      ignorePaths: ignorePaths ?? (withDefaults ? [...DEFAULT_IGNORE] : null),
      ignoreIsDefault: ignorePaths === null,
      files: files
        ? files.map((f) => ({
            path: String(f.path),
            change: String(f.change),
            skipReason: (f.skip_reason as string | null) ?? null,
            ignoredBy: (f.ignored_by as string | null) ?? null,
          }))
        : null,
      status: String(repository?.status ?? 'registered'),
      statusDetail: (repository?.status_detail as string | null) ?? null,
      defaultRef: String(repository?.default_ref ?? ''),
      queued: Boolean(job),
      jobState: job?.state ?? null,
      retryCount: job?.retry_count ?? 0,
      // What the detector read in each flagged chunk of the active commit, at most 50.
      flaggedChunks: repository?.active_commit_id
        ? flaggedChunkList(
            (await inScope(scope, (trx) =>
              trx
                .from('chunks')
                .where({ commit_id: repository.active_commit_id, injection_suspected: true })
                .orderByRaw('path collate "C", start_line')
                .limit(50)
                .select('id', 'path', 'start_line', 'end_line', 'text', 'flagged_window')
            )) as FlaggedChunkRow[]
          )
        : [],
      // Where the wait stands: jobs ahead and, within this workspace, what the worker is on.
      queue: job ? await queuePosition(scope, repositoryId) : null,
      activeCommit: active ? { sha: String(active.sha), indexedAt: iso(active.indexed_at) } : null,
      steps: steps.map((s) => ({
        step: String(s.step),
        status: String(s.status),
        startedAt: iso(s.started_at),
        finishedAt: iso(s.finished_at),
        progress: (s.progress as StepProgress | null) ?? null,
      })),
    }
  }

  async ingestStatus({ auth, scope }: HttpContext) {
    const user = auth.getUserOrFail()
    return this.ingestView(user.id, scope.workspace.id, scope.repository!.id)
  }

  /**
   * The ignore list for this repository, one pattern per line; null restores the
   * defaults. Applies on the next run (a forced re-index re-derives the current commit).
   */
  async update({ auth, scope, request, response }: HttpContext) {
    auth.getUserOrFail()
    const input = await request.validateUsing(ignorePathsValidator)
    let ignorePaths: string[] | null = null
    if (input.ignorePaths !== null) {
      try {
        ignorePaths = parseIgnoreList(input.ignorePaths)
      } catch (error) {
        return response.unprocessableEntity({
          errors: [{ field: 'ignorePaths', message: (error as Error).message }],
        })
      }
    }
    await inScope({ userId: auth.user!.id, workspaceId: scope.workspace.id }, (trx) =>
      trx
        .from('repositories')
        .where({ id: scope.repository!.id, workspace_id: scope.workspace.id })
        .update({ ignore_paths: ignorePaths === null ? null : JSON.stringify(ignorePaths) })
    )
    return response.ok({
      ignorePaths: ignorePaths ?? [...DEFAULT_IGNORE],
      ignoreIsDefault: ignorePaths === null,
    })
  }

  /**
   * Queues another run on the default ref; one waiting job per repository and ref (the
   * queue's singleton key). `force` re-derives the commit even if it is already indexed.
   */
  async reindex({ auth, scope, request, response }: HttpContext) {
    const user = auth.getUserOrFail()
    const repository = scope.repository!
    const force = request.input('force') === true || request.input('force') === 'true'
    const id = await enqueueIngest({
      workspaceId: scope.workspace.id,
      repositoryId: repository.id,
      ref: repository.defaultRef,
      actorUserId: user.id,
      trigger: 'manual',
      force,
    })
    if (!id) return response.conflict({ error: 'already_queued' })
    return response.accepted({ queued: true })
  }

  /**
   * Deletes the repository with its index (commits, files, chunks, symbols and the rest
   * cascade from the repository row) and its webhook inbox. The audit and telemetry
   * ledgers are append-only and keep their rows. Ingestion keeps no working
   * tree: clones live in a temporary directory for the length of one job.
   */
  async destroy({ auth, scope, request, response }: HttpContext) {
    const user = auth.getUserOrFail()
    const repository = scope.repository!
    const queue = await ingestQueue()
    const waiting = await db.rawQuery(
      `select id from pgboss.job where name = :queue and state in ('created', 'retry')
          and data->>'workspaceId' = :workspace and data->>'repositoryId' = :repository`,
      { queue: INGEST_QUEUE, workspace: scope.workspace.id, repository: repository.id }
    )
    for (const row of waiting.rows as Array<{ id: string }>)
      await queue.cancel(INGEST_QUEUE, row.id)
    await inScope({ userId: user.id, workspaceId: scope.workspace.id }, async (trx) => {
      await trx.from('webhook_endpoints').where('repository_id', repository.id).delete()
      await trx
        .from('repositories')
        .where({ id: repository.id, workspace_id: scope.workspace.id })
        .delete()
    })
    securityEvents.emit('repository.deleted', {
      repositoryId: repository.id,
      requestId: request.id() ?? '',
    })
    return response.noContent()
  }
}
