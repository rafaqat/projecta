import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { inScope } from '#app/security/scope'
import { priceTable } from '#app/cost/turn_cost'
import { aggregateSpend, ledgerPrice, ledgerRows, type SpendLine } from '#app/cost/spend'
import WorkspacePolicy from '#policies/workspace_policy'

const NOTE =
  'Spend attributed from the priced cost ledger, not the provider invoice; the reconciler is the accounting truth.'

/** A window of 1 to 90 whole days, 30 when not given; anything else is refused, not clamped. */
function windowOf(raw: unknown): { days: number; from: Date } | null {
  const days = raw === undefined || raw === null || raw === '' ? 30 : Number(raw)
  if (!Number.isInteger(days) || days < 1 || days > 90) return null
  return { days, from: new Date(Date.now() - days * 86_400_000) }
}

/**
 * Attributed spend (WP-25). Two routes, one rule: a member reads their own spend; a
 * workspace owner reads the workspace's, per member. Everyone else gets, for the per-member route,
 * exactly what a route that does not exist returns — never a 403 that confirms there is something
 * to see. Members are listed by name: an ordering by amount is a ranking, and rules ranking
 * out, so the response carries no rank, and no field framed as output or throughput.
 */
export default class SpendController {
  /** GET /api/w/:workspace/spend — the reader's own spend in this workspace. */
  async own({ auth, scope, request, response }: HttpContext) {
    const window = windowOf(request.input('days'))
    if (!window) return response.badRequest({ error: 'days must be a whole number from 1 to 90' })
    const user = auth.getUserOrFail()
    const rows = await inScope({ userId: user.id, workspaceId: scope.workspace.id }, (trx) =>
      ledgerRows(trx, scope.workspace.id, window.from, user.id)
    )
    const { totals, breakdown } = aggregateSpend(rows, ledgerPrice)
    return {
      window: { days: window.days, from: window.from.toISOString() },
      priceVersion: priceTable().version,
      basis: 'attributed',
      note: NOTE,
      // as accepted: owners see per-member spend by default, and every member is told.
      ownerSeesMembers: true,
      totals,
      breakdown,
    }
  }

  /** GET /api/w/:workspace/spend/members — the workspace's spend by member, for an owner only. */
  async members({ auth, bouncer, scope, request, response }: HttpContext) {
    if (!(await bouncer.with(WorkspacePolicy).allows('manage', scope.workspace)))
      return response.notFound({ error: 'Not found' })
    const window = windowOf(request.input('days'))
    if (!window) return response.badRequest({ error: 'days must be a whole number from 1 to 90' })
    const user = auth.getUserOrFail()
    const workspaceScope = { userId: user.id, workspaceId: scope.workspace.id }
    const { rows, memberships } = await inScope(workspaceScope, async (trx) => ({
      rows: await ledgerRows(trx, scope.workspace.id, window.from),
      memberships: (await trx
        .from('workspace_memberships')
        .where('workspace_id', scope.workspace.id)
        .select('user_id', 'role')) as Array<{ user_id: number; role: string }>,
    }))
    const { totals, byUser, breakdown } = aggregateSpend(rows, ledgerPrice)
    // Everyone who spent in the window and everyone who is a member: a departed member's spend is
    // still this workspace's, and a total must add up to its rows.
    const ids = [...new Set([...memberships.map((m) => Number(m.user_id)), ...byUser.keys()])]
    const users = ids.length
      ? ((await db.from('users').whereIn('id', ids).select('id', 'full_name', 'email')) as Array<{
          id: number
          full_name: string | null
          email: string
        }>)
      : []
    const roleOf = new Map(memberships.map((m) => [Number(m.user_id), m.role]))
    const zero: SpendLine = {
      usd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      calls: 0,
    }
    const members = users
      .map((u) => ({
        name: u.full_name?.trim() || u.email,
        email: u.email,
        membership: roleOf.get(Number(u.id)) ?? 'former',
        totals: byUser.get(Number(u.id)) ?? zero,
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email))
    return {
      window: { days: window.days, from: window.from.toISOString() },
      priceVersion: priceTable().version,
      basis: 'attributed',
      note: NOTE,
      totals,
      members,
      breakdown,
    }
  }
}
