import { randomUUID } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { inScope } from '#app/security/scope'
import { isHandle, newHandle } from '#app/security/handles'
import { RateWindow } from '#app/security/rate_window'
import {
  exportSource,
  renderExport,
  turnInRepository,
  turnLive,
} from '#app/dependencies/export_source'
import {
  isShareFormat,
  newShareToken,
  SHARE_TTL_MS,
  shareTokenHash,
} from '#app/dependencies/share_links'
import User from '#models/user'
import Repository from '#models/repository'
import RepositoryPolicy from '#policies/repository_policy'
import WorkspacePolicy from '#policies/workspace_policy'

/** Per token and per client address: enough for a person and a CI retry, not for a scan. */
const perToken = new RateWindow(20, 60_000)
const perClient = new RateWindow(60, 60_000)

/** The first three octets of IPv4, the first three groups of IPv6: enough to tell fetchers apart. */
function truncatedAddress(ip: string): string {
  if (ip.includes('.')) return ip.split('.').slice(0, 3).join('.') + '.0'
  return ip.split(':').slice(0, 3).join(':') + '::'
}

async function audit(
  trx: TransactionClientContract,
  workspaceId: string,
  event: string,
  payload: Record<string, unknown>
) {
  await trx.table('audit_outbox').insert({
    workspace_id: workspaceId,
    event,
    payload: JSON.stringify(payload),
  })
}

/**
 * BOM share links (WP-23): a turn's dependency document, in one format, fetchable for
 * fifteen minutes without a session.
 *
 * Creating, listing and revoking are ordinary session routes under `repository:view`. Fetching is
 * the first route in this system that serves tenant data without one, so it is built to trust
 * nothing it is handed: the token is looked up only by its hash, through a routing table that
 * says whose link it is; the fetch then runs as that creator, inside their scope, and re-asks
 * `RepositoryPolicy.view` — the same check the session routes make — so a link never outlives its
 * creator's access. Every failure is the same 404, and every fetch is an audit event.
 */
export default class BomSharesController {
  /** POST …/turns/:turn/dependencies/links { format } */
  async store({ auth, scope, params, request, response }: HttpContext) {
    const format = request.input('format')
    if (!isHandle(params.turn) || !isShareFormat(format))
      return response.notFound({ error: 'no such turn here' })
    const user = auth.getUserOrFail()
    const repository = scope.repository!
    const { token, hash } = newShareToken()
    const createdAt = new Date()
    const expiresAt = new Date(createdAt.getTime() + SHARE_TTL_MS)
    const handle = newHandle()
    const created = await inScope(
      { userId: user.id, workspaceId: scope.workspace.id },
      async (trx) => {
        const turn = await turnInRepository(trx, repository.id, params.turn)
        if (!turn) return false
        const id = randomUUID()
        await trx.table('bom_share_links').insert({
          id,
          handle,
          workspace_id: scope.workspace.id,
          repository_id: repository.id,
          turn_id: turn.id,
          commit_id: turn.commitId,
          format,
          created_by: user.id,
          created_at: createdAt,
          expires_at: expiresAt,
        })
        await trx.table('bom_share_routes').insert({
          token_hash: hash,
          link_id: id,
          workspace_id: scope.workspace.id,
          acts_as_user_id: user.id,
        })
        await audit(trx, scope.workspace.id, 'bom_share.created', {
          link: handle,
          format,
          runHandle: params.turn,
          expiresAt: expiresAt.toISOString(),
          by: user.id,
        })
        return true
      }
    )
    if (!created) return response.notFound({ error: 'no such turn here' })
    // A path, not an absolute URL: the client prefixes its own origin, so no Host header decides
    // where a credential points.
    return response.created({
      link: handle,
      format,
      path: `/s/bom/${token}`,
      expiresAt: expiresAt.toISOString(),
    })
  }

  /** GET …/turns/:turn/dependencies/links — the caller's own live links for the turn. */
  async index({ auth, scope, params, response }: HttpContext) {
    if (!isHandle(params.turn)) return response.notFound({ error: 'no such turn here' })
    const user = auth.getUserOrFail()
    const repository = scope.repository!
    const links = await inScope(
      { userId: user.id, workspaceId: scope.workspace.id },
      async (trx) => {
        const turn = await turnInRepository(trx, repository.id, params.turn)
        if (!turn) return null
        return trx
          .from('bom_share_links')
          .where({ turn_id: turn.id, created_by: user.id })
          .whereNull('revoked_at')
          .where('expires_at', '>', new Date())
          .orderBy('created_at', 'desc')
          .select('handle as link', 'format', 'expires_at as expiresAt')
      }
    )
    if (!links) return response.notFound({ error: 'no such turn here' })
    return { links }
  }

  /** DELETE …/dependencies/links/:link — by its creator or a workspace owner. */
  async destroy({ auth, bouncer, scope, params, response }: HttpContext) {
    if (!isHandle(params.link)) return response.notFound({ error: 'no such link here' })
    const user = auth.getUserOrFail()
    const repository = scope.repository!
    const owner = await bouncer.with(WorkspacePolicy).allows('manage', scope.workspace)
    const revoked = await inScope(
      { userId: user.id, workspaceId: scope.workspace.id },
      async (trx) => {
        const link = (await trx
          .from('bom_share_links')
          .where({ handle: params.link, repository_id: repository.id })
          .whereNull('revoked_at')
          .first()) as { id: string; created_by: number; format: string } | undefined
        // Someone else's link is as absent as a missing one: 404 either way, never 403.
        if (!link || (link.created_by !== user.id && !owner)) return false
        await trx
          .from('bom_share_links')
          .where('id', link.id)
          .update({ revoked_at: new Date(), revoked_by: user.id })
        await trx.from('bom_share_routes').where('link_id', link.id).delete()
        await audit(trx, scope.workspace.id, 'bom_share.revoked', {
          link: params.link,
          format: link.format,
          by: user.id,
        })
        return true
      }
    )
    if (!revoked) return response.notFound({ error: 'no such link here' })
    return response.noContent()
  }

  /** GET /s/bom/:token — no session, no cookie, the creator's current access re-checked. */
  async fetch({ params, request, response }: HttpContext) {
    const gone = () => response.notFound({ error: 'not_found' })
    const hash = shareTokenHash(params.token)
    const client = truncatedAddress(request.ip())
    if (!perClient.allow(client) || (hash && !perToken.allow(hash)))
      return response.tooManyRequests({ error: 'slow_down' })
    if (!hash) return gone()

    const route = (await db.from('bom_share_routes').where('token_hash', hash).first()) as
      { link_id: string; workspace_id: string; acts_as_user_id: number } | undefined
    if (!route) return gone()
    const creator = await User.find(route.acts_as_user_id)
    if (!creator) return gone()
    // Still a member of the link's workspace? Asked in the creator's own scope, where they can see
    // their own membership, before entering the workspace's: a creator who has left gets the same
    // 404 as everyone, rather than the tenancy guard raising inside the workspace scope.
    const member = await inScope({ userId: creator.id }, (trx) =>
      trx
        .from('workspace_memberships')
        .where({ workspace_id: route.workspace_id, user_id: creator.id })
        .first()
    )
    if (!member) return gone()

    const scope = { userId: creator.id, workspaceId: route.workspace_id }
    const link = await inScope(scope, async (trx) => {
      const row = (await trx
        .from('bom_share_links')
        .where('id', route.link_id)
        .whereNull('revoked_at')
        .where('expires_at', '>', new Date())
        .first()) as
        | {
            handle: string
            repository_id: string
            turn_id: string
            commit_id: string
            format: 'spdx' | 'cyclonedx'
          }
        | undefined
      if (!row || !(await turnLive(trx, row.turn_id))) return null
      const repository = await Repository.query({ client: trx })
        .where('id', row.repository_id)
        .first()
      return repository ? { row, repository } : null
    })
    if (!link) return gone()
    // The creator's access now, not when they made the link: the check the session routes make.
    if (!(await new RepositoryPolicy().view(creator, link.repository))) return gone()

    const source = await inScope(scope, async (trx) => {
      const found = await exportSource(trx, link.repository.id, link.row.commit_id)
      if (found)
        await audit(trx, route.workspace_id, 'bom_share.fetched', {
          link: link.row.handle,
          format: link.row.format,
          userAgent: String(request.header('user-agent') ?? '').slice(0, 200),
          client,
        })
      return found
    })
    if (!source) return gone()
    const { body, mediaType, file } = renderExport(link.row.format, source, link.repository.name)
    response.header('content-type', `${mediaType}; charset=utf-8`)
    response.header('content-disposition', `attachment; filename="${file}"`)
    response.header('cache-control', 'private, no-store')
    response.header('referrer-policy', 'no-referrer')
    return response.send(body)
  }
}
