import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import logger from '@adonisjs/core/services/logger'
import env from '#start/env'
import { progressChain } from '#app/ingest/stall'
import {
  COMMIT_SHA,
  GitRunner,
  HistoryFetchError,
  type HistoryFetchCode,
} from '#app/ingest/git_runner'
import {
  COCHANGE_CONFIG,
  countCochanges,
  parseHistoryLog,
  type CochangePair,
} from '#app/ingest/cochange'
import {
  DEFAULT_LIMITS,
  skipReasonFor,
  type IngestLimits,
  type SkipReason,
} from '#app/ingest/limits'
import {
  blobSizes,
  listTree,
  MODE_GITLINK,
  readBlobs,
  type TreeEntry,
  MODE_SYMLINK,
} from '#app/ingest/object_reader'
import { collidesWithCanary } from '#app/ingest/canary_collision'
import { REDACTOR_VERSION, redactSecrets } from '#app/ingest/secret_redaction'
import { securityEvents } from '#app/security/events/index'
import { validateRepositoryUrl } from '#app/ingest/url_policy'
import { faultInjected } from '#app/security/ablation_switch'
import { derivationKey, workspaceKey } from '#app/security/derivation_keys'
import { inScope, type Scope } from '#app/security/scope'
import { appMetrics } from '#app/security/telemetry/metrics'
import { DEFAULT_IGNORE, ignoredBy } from '#app/ingest/ignore'
import { Indexer, type IndexProgress, type IndexOutcome } from '#app/ingest/indexer'
import { rateJump, type FlaggedCounts } from '#app/ingest/injection_rate'

export interface IngestRequest {
  workspaceId: string
  repositoryId: string
  ref?: string
  actorUserId: number
  /** Re-derive the commit even if it was indexed (the ignore list changed). */
  force?: boolean
  /**
   * Index this commit instead of the branch head ('s pinned corpus). A full lowercase
   * object id; anything else is refused before a git command runs.
   */
  commit?: string
}

export interface IngestOutcome {
  commitSha: string
  commitId: string
  noop: boolean
  files: number
  blobsRead: number
  skipped: number
  changes: Record<string, number>
  index?: IndexOutcome
}

export type IngestStep = 'resolve' | 'read_tree' | 'cochange' | 'index' | 'activate'
const STEPS: IngestStep[] = ['resolve', 'read_tree', 'cochange', 'index', 'activate']

interface RepositoryRow {
  id: string
  url: string
  default_ref: string
  active_commit_id: string | null
  /** The workspace's ignore list for this repository; null means the defaults. */
  ignore_paths: string[] | null
}

/**
 * Ingestion (design §4). Every step is keyed by
 * (repository, commit, step) and recorded before and after it runs, so a
 * crashed job resumes at the first unfinished step and a repeated request
 * for an already indexed commit is a no-op. Nothing here creates a working
 * tree or spawns a shell; contents come from the object database only.
 */
export type IngestProgress = IndexProgress

export class IngestPipeline {
  constructor(
    private readonly limits: IngestLimits = DEFAULT_LIMITS,
    private readonly indexer: Indexer = new Indexer(),
    /** Every progress report of the index step, before it is written (tests, logs). */
    private readonly onProgress: (progress: IngestProgress) => void = () => {}
  ) {}

  async run(request: IngestRequest): Promise<IngestOutcome> {
    // First, before the repository is read or a git process exists: a pin reaches a command line.
    if (request.commit !== undefined && !COMMIT_SHA.test(request.commit))
      throw new Error('commit id must be a full lowercase object id')
    const scope: Scope = { userId: request.actorUserId, workspaceId: request.workspaceId }
    const repository = await inScope(scope, async (trx) => {
      const row = await trx
        .from('repositories')
        .where({ id: request.repositoryId, workspace_id: request.workspaceId })
        .first()
      if (!row) throw new Error('repository not found in the actor scope')
      return row as RepositoryRow
    })
    const policy = validateRepositoryUrl(repository.url, env.get('GIT_ALLOWED_HOSTS').split(','))
    if (!policy.ok) throw new Error(`repository URL rejected by policy: ${policy.reason}`)
    const cwd = await mkdtemp(join(tmpdir(), 'ingest-'))
    try {
      const runner = new GitRunner({ cwd })
      await runner.init()
      // `HEAD` stands for "whatever the remote's default branch is" (registration without a
      // branch): resolved once here and written back, so later runs and webhooks name it.
      let ref = request.ref ?? repository.default_ref
      if (ref === 'HEAD') {
        ref = await runner.defaultBranch(policy.url)
        await inScope(scope, (trx) =>
          trx
            .from('repositories')
            .where({ id: repository.id, workspace_id: request.workspaceId })
            .update({ default_ref: ref })
        )
      }
      await runner.fetch(policy.url, ref, request.commit)
      const commitSha = await runner.resolveRef(ref)
      const formatOut = await runner.run(['rev-parse', '--show-object-format'])
      const objectFormat = formatOut.toString().trim()

      // `force` re-derives an indexed commit (an ignore list changed): every step runs again.
      const done = request.force
        ? new Set<IngestStep>()
        : await this.completedSteps(scope, repository.id, commitSha)
      if (done.has('activate')) {
        const commitId = await this.commitId(scope, repository.id, commitSha)
        return { commitSha, commitId, noop: true, files: 0, blobsRead: 0, skipped: 0, changes: {} }
      }

      const commitId = await this.step(
        scope,
        repository.id,
        commitSha,
        'resolve',
        request.actorUserId,
        done,
        () => this.resolve(scope, repository.id, commitSha, ref, objectFormat)
      )
      const tree = await this.step(
        scope,
        repository.id,
        commitSha,
        'read_tree',
        request.actorUserId,
        done,
        () => this.readTree(scope, runner, repository, commitId, commitSha)
      )
      await this.step(scope, repository.id, commitSha, 'cochange', request.actorUserId, done, () =>
        this.cochange(
          scope,
          runner,
          policy.url,
          ref,
          commitId,
          commitSha,
          request.commit !== undefined
        )
      )
      const index = await this.step(
        scope,
        repository.id,
        commitSha,
        'index',
        request.actorUserId,
        done,
        async () => {
          const progress = this.progressWriter(scope, repository.id, commitSha)
          const outcome = await this.indexer.index(
            scope,
            commitId,
            repository.active_commit_id,
            progress.report
          )
          await progress.flush()
          return outcome
        }
      )
      // Before activation, so the comparison reads the previous commit's index step, not this one.
      await this.reportInjectionRate(scope, repository.id, commitSha, index)
      await this.step(scope, repository.id, commitSha, 'activate', request.actorUserId, done, () =>
        this.activate(scope, repository.id, commitId)
      )
      return { commitSha, commitId, noop: false, ...tree, index }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }

  /**
   * Writes the index step's progress onto its row (`progress`) so the
   * repository page can show it while the step runs: at most twice a second,
   * always on a phase change and on the last report. Writes are serialised so
   * a slow one never overtakes a later report, and `flush` waits for the last
   * before the step is marked done.
   */
  private progressWriter(scope: Scope, repositoryId: string, commitSha: string) {
    let last = 0
    let phase: IngestProgress['phase'] | null = null
    // A failed write is logged with its code and hash and dropped; it never blocks the next one
    // (: a write hung on a dead connection once held a job silent for four hours).
    const writes = progressChain(
      (progress: IngestProgress) =>
        inScope(scope, (trx) =>
          trx
            .from('ingest_steps')
            .where({ repository_id: repositoryId, commit_sha: commitSha, step: 'index' })
            .update({ progress: JSON.stringify(progress) })
        ),
      (error, progress) =>
        logger.warn(
          {
            errorCode: 'E_INGEST_PROGRESS_WRITE',
            errorHash: createHash('sha256')
              .update(error instanceof Error ? error.message : String(error))
              .digest('hex')
              .slice(0, 16),
            repositoryId,
            progress,
          },
          'ingest progress write failed; dropped'
        )
    )
    const report = (progress: IngestProgress) => {
      this.onProgress(progress)
      const now = Date.now()
      const due = progress.phase !== phase || progress.done === progress.total || now - last >= 500
      if (!due) return
      last = now
      phase = progress.phase
      writes.report(progress)
    }
    return { report, flush: writes.flush }
  }

  private async completedSteps(
    scope: Scope,
    repositoryId: string,
    commitSha: string
  ): Promise<Set<IngestStep>> {
    const rows = await inScope(scope, (trx) =>
      trx
        .from('ingest_steps')
        .where({ repository_id: repositoryId, commit_sha: commitSha, status: 'done' })
        .select('step')
    )
    return new Set(rows.map((r) => r.step as IngestStep))
  }

  private async commitId(scope: Scope, repositoryId: string, commitSha: string): Promise<string> {
    const row = await inScope(scope, (trx) =>
      trx.from('commits').where({ repository_id: repositoryId, sha: commitSha }).first()
    )
    return row!.id
  }

  /** Runs one step unless it already completed; records running → done. */
  /**
   * Says once when a commit's share of flagged chunks jumped against the previous commit of this
   * repository (owner 2026-09-18). A level is noise at a 0.153 false-positive rate; a
   * change is not. Reports only: nothing here changes what was indexed, and a quiet ingest is not
   * evidence of a clean repository — recall is 0.405, and a ranking carrier is never flagged.
   */
  private async reportInjectionRate(
    scope: Scope,
    repositoryId: string,
    commitSha: string,
    current: IndexOutcome | undefined
  ) {
    if (!current) return
    const previousRow = await inScope(scope, (trx) =>
      trx
        .from('ingest_steps')
        .where({ repository_id: repositoryId, step: 'index', status: 'done' })
        .whereNot('commit_sha', commitSha)
        .orderBy('finished_at', 'desc')
        .select('result')
        .first()
    )
    const previous = previousRow?.result as FlaggedCounts | undefined
    const jump = rateJump(
      previous && typeof previous.chunks === 'number' ? previous : null,
      current
    )
    if (!jump) return
    securityEvents.emit('ingest.injection_rate_changed', {
      repositoryId,
      previousRate: Number(jump.previousRate.toFixed(3)),
      rate: Number(jump.rate.toFixed(3)),
      flagged: jump.flagged,
      chunks: jump.chunks,
    })
  }

  private async step<T>(
    scope: Scope,
    repositoryId: string,
    commitSha: string,
    name: IngestStep,
    actor: number,
    done: Set<IngestStep>,
    fn: () => Promise<T>
  ): Promise<T> {
    if (done.has(name)) {
      const row = await inScope(scope, (trx) =>
        trx
          .from('ingest_steps')
          .where({ repository_id: repositoryId, commit_sha: commitSha, step: name })
          .first()
      )
      return row!.result as T
    }
    await inScope(scope, (trx) =>
      trx
        .table('ingest_steps')
        .insert({
          workspace_id: scope.workspaceId,
          repository_id: repositoryId,
          commit_sha: commitSha,
          step: name,
          status: 'running',
          actor_user_id: actor,
          started_at: new Date(),
        })
        .onConflict(['repository_id', 'commit_sha', 'step'])
        .merge({ status: 'running', started_at: new Date(), finished_at: null })
    )
    const startedAt = Date.now()
    const result = await fn()
    appMetrics.ingestStep(name, Date.now() - startedAt)
    await inScope(scope, (trx) =>
      trx
        .from('ingest_steps')
        .where({ repository_id: repositoryId, commit_sha: commitSha, step: name })
        .update({ status: 'done', result: JSON.stringify(result ?? {}), finished_at: new Date() })
    )
    return result
  }

  private async resolve(
    scope: Scope,
    repositoryId: string,
    commitSha: string,
    ref: string,
    objectFormat: string
  ): Promise<string> {
    return inScope(scope, async (trx) => {
      const existing = await trx
        .from('commits')
        .where({ repository_id: repositoryId, sha: commitSha })
        .first()
      const commitId: string = existing?.id ?? randomUUID()
      if (!existing) {
        await trx.table('commits').insert({
          id: commitId,
          workspace_id: scope.workspaceId,
          repository_id: repositoryId,
          sha: commitSha,
          object_format: objectFormat,
          status: 'indexing',
          created_at: new Date(),
        })
      }
      await trx
        .table('refs')
        .insert({
          workspace_id: scope.workspaceId,
          repository_id: repositoryId,
          name: ref,
          commit_sha: commitSha,
          updated_at: new Date(),
        })
        .onConflict(['repository_id', 'name'])
        .merge({ commit_sha: commitSha, updated_at: new Date() })
      return commitId
    })
  }

  private async readTree(
    scope: Scope,
    runner: GitRunner,
    repository: RepositoryRow,
    commitId: string,
    commitSha: string
  ) {
    const tree = await listTree(runner, commitSha)
    const entries = tree.filter((e) => e.type === 'blob' || e.mode === MODE_GITLINK)
    if (entries.length > this.limits.maxFiles)
      throw new Error(`repository exceeds ${this.limits.maxFiles} files`)

    const previous = new Map<string, string>()
    if (repository.active_commit_id) {
      const rows = await inScope(scope, (trx) =>
        trx
          .from('files')
          .where({ workspace_id: scope.workspaceId!, commit_id: repository.active_commit_id! })
          .select('path', 'blob_sha')
      )
      for (const row of rows) previous.set(row.path, row.blob_sha)
    }
    const previousShas = new Set(previous.values())
    const changes: Record<string, number> = {
      added: 0,
      modified: 0,
      renamed: 0,
      unchanged: 0,
      gitlink: 0,
    }
    const classify = (entry: TreeEntry): string => {
      if (entry.mode === MODE_GITLINK) return 'gitlink'
      const before = previous.get(entry.path)
      if (before === entry.sha) return 'unchanged'
      if (before !== undefined) return 'modified'
      return previousShas.has(entry.sha) ? 'renamed' : 'added'
    }

    // Ignored paths are recorded as files of the commit, named by the pattern, and never
    // read: no blob, no bytes over the wire, nothing to chunk or embed.
    const patterns = repository.ignore_paths ?? DEFAULT_IGNORE
    // Blobs only: a symlink or a submodule is never read anyway and keeps its own reason.
    const ignored = new Map<string, string>()
    for (const entry of entries) {
      if (entry.mode === MODE_GITLINK || entry.mode === MODE_SYMLINK) continue
      const by = ignoredBy(entry.path, patterns)
      if (by) ignored.set(entry.path, by)
    }
    changes.ignored = 0
    const blobEntries = entries.filter((e) => e.mode !== MODE_GITLINK && !ignored.has(e.path))
    // Scoped by workspace in the query as well as by policy: a session that
    // bypasses row-level security must not see another tenant's blobs as already known.
    const knownRows = await inScope(scope, (trx) =>
      trx
        .from('blobs')
        .where('workspace_id', scope.workspaceId!)
        .whereIn(
          'blob_sha',
          blobEntries.map((e) => e.sha)
        )
        .select('blob_sha')
    )
    const known = new Set(knownRows.map((r) => r.blob_sha))
    const wanted = [...new Set(blobEntries.filter((e) => !known.has(e.sha)).map((e) => e.sha))]
    const sizes = await blobSizes(runner, wanted)
    let total = 0
    for (const size of sizes.values()) total += size
    if (total > this.limits.maxTotalBytes)
      throw new Error('repository exceeds the total size limit')
    const readable = wanted.filter((sha) => (sizes.get(sha) ?? 0) <= this.limits.maxFileBytes)
    const contents = await readBlobs(runner, readable)
    await faultInjected('ingest_mid_tree')

    const workspaceId = scope.workspaceId!
    const key = workspaceKey(workspaceId)
    let skipped = 0
    await inScope(scope, async (trx) => {
      for (const sha of wanted) {
        const fetched = contents.get(sha)
        // UTF-16 with a byte order mark is text, not binary: stored as UTF-8, hashed as fetched (BL-03).
        const raw = fetched ? decodeUtf16(fetched) : fetched
        let reason: SkipReason | null = raw ? skipReasonFor(raw, this.limits) : 'file_too_large'
        if (!reason && (await collidesWithCanary(trx, raw!))) {
          // Loud at index time, never a silent hold at answer time (BL-05).
          reason = 'canary_collision'
          securityEvents.emit('ingest.rejected', {
            reason,
            repositoryId: repository.id,
            requestId: '',
          })
        }
        if (reason) skipped++
        const stored = reason ? null : await this.redacted(trx, workspaceId, key, sha, raw!)
        await trx
          .table('blobs')
          .insert({
            workspace_id: scope.workspaceId,
            blob_sha: sha,
            content_sha256: createHash('sha256')
              .update(fetched ?? Buffer.alloc(0))
              .digest('hex'),
            size: sizes.get(sha) ?? 0,
            content: stored?.content ?? null,
            skip_reason: reason,
            redacted: (stored?.findings.length ?? 0) > 0,
            created_at: new Date(),
          })
          .onConflict(['workspace_id', 'blob_sha'])
          .ignore()
        for (const finding of stored?.findings ?? []) {
          await trx
            .table('redactions')
            .insert({
              workspace_id: scope.workspaceId,
              blob_sha: sha,
              rule: finding.rule,
              fingerprint: finding.fingerprint,
              line: finding.line,
            })
            .onConflict(['workspace_id', 'blob_sha', 'rule', 'line'])
            .ignore()
        }
      }
      await trx.from('files').where('commit_id', commitId).delete()
      for (const entry of entries) {
        const change = classify(entry)
        changes[change]++
        const matchedPattern = ignored.get(entry.path) ?? null
        if (matchedPattern) changes.ignored++
        await trx.table('files').insert({
          workspace_id: scope.workspaceId,
          commit_id: commitId,
          path: entry.path,
          blob_sha: entry.sha,
          mode: entry.mode,
          change,
          ignored_by: matchedPattern,
        })
      }
    })
    return { files: entries.length, blobsRead: readable.length, skipped, changes }
  }

  /**
   * Files that change together: history fetched without contents, the one allowed
   * log read, pairs over the indexed paths, written for the commit in one transaction. The step
   * never fails the ingest: a failure is recorded as `not_indexed` with its code and reported,
   * and the commit still activates — tools then say history is not indexed, never "no companions".
   */
  private async cochange(
    scope: Scope,
    runner: GitRunner,
    url: string,
    ref: string,
    commitId: string,
    commitSha: string,
    pinned = false
  ): Promise<{
    status: 'indexed' | 'not_indexed'
    reason: HistoryFetchCode | null
    pairs: number
  }> {
    const record = (row: {
      status: 'indexed' | 'not_indexed'
      reason: HistoryFetchCode | null
      commitsRead: number
      bulkSkipped: number
      pairs: CochangePair[]
    }) =>
      inScope(scope, async (trx) => {
        await trx.from('file_cochanges').where('commit_id', commitId).delete()
        for (let i = 0; i < row.pairs.length; i += 500)
          await trx.table('file_cochanges').insert(
            row.pairs.slice(i, i + 500).map((pair) => ({
              workspace_id: scope.workspaceId,
              commit_id: commitId,
              path_a: pair.pathA,
              path_b: pair.pathB,
              together: pair.together,
              changes_a: pair.changesA,
              changes_b: pair.changesB,
            }))
          )
        await trx
          .table('commit_history')
          .insert({
            workspace_id: scope.workspaceId,
            commit_id: commitId,
            status: row.status,
            reason_code: row.reason,
            commits_read: row.commitsRead,
            bulk_skipped: row.bulkSkipped,
            recorded_at: new Date(),
          })
          .onConflict(['commit_id'])
          .merge()
      })

    try {
      await runner.fetchHistory(url, ref, commitSha, COCHANGE_CONFIG.windowCommits, pinned)
      const log = await runner.run(runner.historyLogArgs(commitSha))
      // A shallow boundary commit's parent was not fetched: its diff is its whole tree.
      const shallowFile = await runner
        .run(['rev-parse', '--git-path', 'shallow'])
        .then((out) => readFile(join(runner.cwd, out.toString().trim()), 'utf8'))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return '' // the window reached the root: nothing shallow
          throw error
        })
      const shallow = new Set(shallowFile.split('\n').filter(Boolean))
      const indexed = await inScope(scope, async (trx) => {
        const rows = (await trx
          .from('files')
          .join('blobs', function () {
            this.on('blobs.blob_sha', 'files.blob_sha').andOn(
              'blobs.workspace_id',
              'files.workspace_id'
            )
          })
          .where('files.commit_id', commitId)
          .whereNull('files.ignored_by')
          .whereNull('blobs.skip_reason')
          .whereNot('files.mode', MODE_GITLINK)
          .select('files.path')) as Array<{ path: string }>
        return new Set(rows.map((r) => r.path))
      })
      const result = countCochanges(parseHistoryLog(log), indexed, shallow)
      await record({ status: 'indexed', reason: null, ...result })
      return { status: 'indexed', reason: null, pairs: result.pairs.length }
    } catch (error) {
      const reason: HistoryFetchCode =
        error instanceof HistoryFetchError ? error.code : 'COCHANGE_GIT_FAILED'
      securityEvents.emit('error.unhandled', {
        errorCode: reason,
        errorHash: createHash('sha256')
          .update(error instanceof Error ? error.message : String(error))
          .digest('hex')
          .slice(0, 16),
      })
      await record({ status: 'not_indexed', reason, commitsRead: 0, bulkSkipped: 0, pairs: [] })
      return { status: 'not_indexed', reason, pairs: 0 }
    }
  }

  /** Redaction results are cached under a workspace-keyed derivation key. */
  private async redacted(
    trx: TransactionClientContract,
    workspaceId: string,
    key: Buffer,
    sha: string,
    raw: Buffer
  ) {
    const cacheKey = derivationKey(key, 'redact', sha, REDACTOR_VERSION)
    const hit = await trx
      .from('derivation_cache')
      .where({ workspace_id: workspaceId, key: cacheKey })
      .first()
    if (hit) return hit.value as ReturnType<typeof redactSecrets>
    const result = redactSecrets(raw.toString('utf8'), key)
    await trx
      .table('derivation_cache')
      .insert({
        workspace_id: workspaceId,
        key: cacheKey,
        kind: 'redaction',
        value: JSON.stringify(result),
        created_at: new Date(),
      })
      .onConflict(['workspace_id', 'key'])
      .ignore()
    return result
  }

  /** One transaction flips the active commit; readers see the old or the new index, never a mixture. */
  private async activate(
    scope: Scope,
    repositoryId: string,
    commitId: string
  ): Promise<{ activated: true }> {
    await inScope(scope, async (trx) => {
      await trx
        .from('commits')
        .where('id', commitId)
        .update({ status: 'active', indexed_at: new Date() })
      await trx
        .from('repositories')
        .where('id', repositoryId)
        .update({ active_commit_id: commitId, status: 'indexed' })
    })
    return { activated: true }
  }
}

/** Content hash of an indexed commit: what "identical index" means in tests. */
export async function indexHash(scope: Scope, commitId: string): Promise<string> {
  return inScope(scope, async (trx) => {
    const files = await trx
      .from('files')
      .where({ workspace_id: scope.workspaceId!, commit_id: commitId })
      .orderBy('path')
      .select('path', 'blob_sha', 'mode', 'change')
    const blobs = await trx
      .from('blobs')
      .where('workspace_id', scope.workspaceId!)
      .whereIn(
        'blob_sha',
        files.map((f) => f.blob_sha)
      )
      .orderBy('blob_sha')
      .select('blob_sha', 'content_sha256', 'skip_reason', 'redacted', 'content')
    return createHash('sha256').update(JSON.stringify({ files, blobs })).digest('hex')
  })
}

export { STEPS }

/** A UTF-16 file (BOM FF FE or FE FF) as UTF-8 bytes; anything else unchanged. */
function decodeUtf16(bytes: Buffer): Buffer {
  if (bytes.length < 2) return bytes
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return Buffer.from(bytes.subarray(2).toString('utf16le'), 'utf8')
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2))
    swapped.swap16()
    return Buffer.from(swapped.toString('utf16le'), 'utf8')
  }
  return bytes
}
