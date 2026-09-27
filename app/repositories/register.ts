import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import logger from '@adonisjs/core/services/logger'
import env from '#start/env'
import { GitRunner, isSafeRefName, type GitError } from '#app/ingest/git_runner'
import { enqueueIngest } from '#app/ingest/queue'
import { validateRepositoryUrl } from '#app/ingest/url_policy'
import { newHandle } from '#app/security/handles'
import { securityEvents } from '#app/security/events/index'
import { inScope } from '#app/security/scope'

/**
 * Registration (SEC-03, SEC-32), shared by the route and the operator command: the URL policy
 * decides first, then a bounded reachability pre-flight confirms the remote exists and is not empty
 * before a repository row, its push inbox with a per-repository secret, and one queued ingestion are
 * created. A rejection is a security event and a typed result, so an unreachable, missing or empty
 * repository is refused at registration with a clear reason instead of registering and failing later.
 */
export interface RegisterInput {
  url: string
  name?: string
  defaultRef?: string
  visibility?: 'workspace' | 'restricted'
}

export type RegisterResult =
  | {
      ok: true
      handle: string
      webhookHandle: string
      url: string
      repositoryId: string
      /** False when the workspace already had this URL: that repository; queued again only if it never indexed or failed. */
      created: boolean
    }
  | { ok: false; field: 'url' | 'defaultRef'; message: string }

/**
 * A bounded reachability check on an already-URL-validated remote: `ls-remote --symref` under the
 * hardened git config (terminal prompts disabled), on a short timeout so a bad URL fails in seconds,
 * not the ingest's two minutes. The three failure modes map to a clear, user-facing reason.
 */
async function preflightRemote(
  url: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'preflight-'))
  try {
    await new GitRunner({ cwd, timeoutMs: 20_000 }).defaultBranch(url)
    return { ok: true }
  } catch (error) {
    const e = error as GitError
    const message = e instanceof Error ? e.message : String(e)
    // Report the real git failure server-side (never swallow it); the user-facing messages below stay
    // generic on purpose, so git's own text — and whether a private repo exists — is not shown to them.
    logger.warn(
      { err: message, code: e.code, signal: e.signal, url },
      'registration pre-flight failed'
    )
    if (e.signal || /timed out|ETIMEDOUT/i.test(message)) {
      return { ok: false, message: 'repository unreachable: the request timed out' }
    }
    if (/did not name a default branch/i.test(message)) {
      return { ok: false, message: 'repository is empty: it has no branches to index' }
    }
    // Authentication needed, a 404, or any other failure to read refs: for a public repository this
    // means it does not exist or is not accessible. Git's own text is not shown to the user.
    return {
      ok: false,
      message: 'repository not found or not accessible: check the URL and that it is public',
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

export async function registerRepository(
  actor: { userId: number; workspaceId: string; requestId: string },
  input: RegisterInput
): Promise<RegisterResult> {
  const policy = validateRepositoryUrl(input.url, env.get('GIT_ALLOWED_HOSTS').split(','))
  if (!policy.ok) {
    securityEvents.emit('ingest.rejected', {
      reason: `url_${policy.reason}`,
      requestId: actor.requestId,
    })
    return { ok: false, field: 'url', message: `repository URL rejected: ${policy.reason}` }
  }
  // No branch given: the worker resolves the remote's default branch on the first run.
  const defaultRef = input.defaultRef ?? 'HEAD'
  if (!(await isSafeRefName(defaultRef))) {
    securityEvents.emit('ingest.rejected', { reason: 'ref_unsafe', requestId: actor.requestId })
    return { ok: false, field: 'defaultRef', message: 'invalid ref name' }
  }

  // The same URL again in this workspace is the repository it already has (batch UAT 2026-09-14).
  const existing = await inScope({ userId: actor.userId, workspaceId: actor.workspaceId }, (trx) =>
    trx
      .from('repositories as r')
      .join('webhook_endpoints as w', 'w.repository_id', 'r.id')
      .where({ 'r.workspace_id': actor.workspaceId, 'r.url': policy.url })
      .select('r.id', 'r.handle', 'r.status', 'w.handle as webhook_handle')
      .first()
  )
  if (existing) {
    // One that never indexed, or failed, is queued again; the singleton key keeps one job per repository.
    if (existing.status === 'registered' || existing.status === 'failed') {
      // Back to "registered" now: a poller must not read the old failure as this run's.
      await inScope({ userId: actor.userId, workspaceId: actor.workspaceId }, (trx) =>
        trx
          .from('repositories')
          .where('id', existing.id)
          .update({ status: 'registered', status_detail: null })
      )
      await enqueueIngest({
        workspaceId: actor.workspaceId,
        repositoryId: String(existing.id),
        ref: defaultRef,
        actorUserId: actor.userId,
        trigger: 'registration',
      })
    }
    return {
      ok: true,
      handle: String(existing.handle),
      webhookHandle: String(existing.webhook_handle),
      url: policy.url,
      repositoryId: String(existing.id),
      created: false,
    }
  }
  // A new repository is confirmed reachable before it is stored and queued, so a missing, empty or
  // unreachable remote is refused now with a clear reason rather than registered and failed later.
  const reach = await preflightRemote(policy.url)
  if (!reach.ok) {
    securityEvents.emit('ingest.rejected', {
      reason: 'url_unreachable',
      requestId: actor.requestId,
    })
    return { ok: false, field: 'url', message: reach.message }
  }
  const repository = { id: randomUUID(), handle: newHandle() }
  // The push inbox (SEC-32): an unguessable handle and a per-repository secret, in the
  // unscoped webhook_endpoints table; the secret is never returned.
  const inbox = { handle: newHandle(), secret: randomBytes(32).toString('hex') }
  await inScope({ userId: actor.userId, workspaceId: actor.workspaceId }, async (trx) => {
    await trx.table('repositories').insert({
      ...repository,
      workspace_id: actor.workspaceId,
      name: input.name ?? `${policy.owner}/${policy.name}`,
      url: policy.url,
      visibility: input.visibility ?? 'workspace',
      default_ref: defaultRef,
      status: 'registered',
      created_at: new Date(),
    })
    await trx.table('webhook_endpoints').insert({
      ...inbox,
      workspace_id: actor.workspaceId,
      repository_id: repository.id,
      acts_as_user_id: actor.userId,
      created_at: new Date(),
    })
  })
  await enqueueIngest({
    workspaceId: actor.workspaceId,
    repositoryId: repository.id,
    ref: defaultRef,
    actorUserId: actor.userId,
    trigger: 'registration',
  })
  return {
    ok: true,
    handle: repository.handle,
    webhookHandle: inbox.handle,
    url: policy.url,
    repositoryId: repository.id,
    created: true,
  }
}
