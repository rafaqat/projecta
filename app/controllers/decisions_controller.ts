import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { isHandle } from '#app/security/handles'
import { inScope, type Scope } from '#app/security/scope'

const reviewValidator = vine.compile(
  vine.object({
    outcome: vine.enum(['accept', 'flag']),
    note: vine.string().trim().maxLength(500).optional(),
  })
)

/**
 * The decision drawer (design §9): the decision record for a turn and its
 * review history, read from the chain when the writer has consumed the
 * outbox and from the outbox otherwise. Accept and flag append
 * decision.reviewed through the outbox; nothing here edits a record.
 */
export default class DecisionsController {
  async show({ auth, scope, params, response }: HttpContext) {
    const user = auth.getUserOrFail()
    if (!isHandle(params.turn)) return response.notFound()
    const actor: Scope = { userId: user.id, workspaceId: scope.workspace.id }
    const data = await inScope(actor, async (trx) => {
      const turn = await trx
        .from('turns')
        .join('threads', 'threads.id', 'turns.thread_id')
        .where({ 'turns.run_handle': params.turn, 'threads.repository_id': scope.repository!.id })
        .select(
          'turns.id',
          'turns.run_handle',
          'turns.run_state',
          'turns.released',
          'turns.erased_at',
          'turns.config_hash'
        )
        .first()
      if (!turn) return null
      const [chained, pending] = await Promise.all([
        trx
          .from('audit_events')
          .whereRaw(`payload->>'runHandle' = ?`, [params.turn])
          .orderBy('seq'),
        trx.from('audit_outbox').whereRaw(`payload->>'runHandle' = ?`, [params.turn]).orderBy('id'),
      ])
      const events = [
        ...chained.map((e) => ({ ...e, chained: true })),
        ...pending.map((e) => ({ ...e, chained: false })),
      ]
      const recorded = events.find((e) => e.event === 'decision.recorded')
      return {
        turn: {
          handle: turn.run_handle,
          runState: turn.run_state,
          released: turn.released,
          erased: Boolean(turn.erased_at),
        },
        record: recorded?.payload.record ?? null,
        chained: recorded?.chained ?? false,
        reviews: events
          .filter((e) => e.event === 'decision.reviewed')
          .map((e) => ({ ...e.payload, chained: e.chained })),
      }
    })
    if (!data) return response.notFound()
    return {
      ...data,
      validation: data.record?.system.validatedByRun
        ? { status: 'validated', run: data.record.system.validatedByRun }
        : { status: 'unvalidated configuration' },
    }
  }

  async review({ auth, scope, params, request, response }: HttpContext) {
    const user = auth.getUserOrFail()
    if (!isHandle(params.turn)) return response.notFound()
    const body = await request.validateUsing(reviewValidator)
    const actor: Scope = { userId: user.id, workspaceId: scope.workspace.id }
    const ok = await inScope(actor, async (trx) => {
      const turn = await trx
        .from('turns')
        .join('threads', 'threads.id', 'turns.thread_id')
        .where({ 'turns.run_handle': params.turn, 'threads.repository_id': scope.repository!.id })
        .select('turns.id')
        .first()
      if (!turn) return false
      await trx.table('audit_outbox').insert({
        workspace_id: scope.workspace.id,
        event: 'decision.reviewed',
        payload: JSON.stringify({
          turnId: turn.id,
          runHandle: params.turn,
          outcome: body.outcome,
          note: body.note ?? '',
          reviewer: String(user.id),
          reviewedAt: new Date().toISOString(),
        }),
      })
      return true
    })
    if (!ok) return response.notFound()
    return response.status(201).json({ recorded: true })
  }
}
