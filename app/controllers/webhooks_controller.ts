import { createHmac, timingSafeEqual } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'
import { enqueueIngest } from '#app/ingest/queue'
import { isHandle } from '#app/security/handles'
import { securityEvents } from '#app/security/events/index'
import { inScope } from '#app/security/scope'

interface Endpoint {
  handle: string
  workspace_id: string
  repository_id: string
  secret: string
  acts_as_user_id: number
}

/**
 * GitHub push webhooks (SEC-32). Every delivery is authenticated
 * with X-Hub-Signature-256 over the raw body, indexed only for the
 * repository's configured ref, and de-duplicated by delivery ID. Failures
 * are indistinguishable to the caller (404) so the endpoint is not an oracle.
 */
export default class WebhooksController {
  async github({ params, request, response }: HttpContext) {
    const endpoint = isHandle(params.hook)
      ? ((await db
          .from('webhook_endpoints')
          .where('handle', params.hook)
          .first()) as Endpoint | null)
      : null
    if (!endpoint) return response.notFound({ error: 'not_found' })

    const raw = request.raw() ?? ''
    const presented = request.header('x-hub-signature-256') ?? ''
    const expected = `sha256=${createHmac('sha256', endpoint.secret).update(raw).digest('hex')}`
    if (
      presented.length !== expected.length ||
      !timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
    ) {
      securityEvents.emit('ingest.rejected', {
        reason: 'webhook_signature',
        repositoryId: endpoint.repository_id,
        requestId: request.id() ?? '',
      })
      return response.notFound({ error: 'not_found' })
    }

    const deliveryId = request.header('x-github-delivery') ?? ''
    const event = request.header('x-github-event') ?? ''
    const scope = { userId: endpoint.acts_as_user_id, workspaceId: endpoint.workspace_id }
    const body = request.body() as { ref?: string }

    const outcome = await inScope(scope, async (trx) => {
      const repository = await trx.from('repositories').where('id', endpoint.repository_id).first()
      if (!repository) return 'repository_missing'
      if (!deliveryId) return 'no_delivery_id'
      // Insert-or-ignore records the delivery as 'received'. onConflict(...).ignore() means a second
      // delivery with the same id never raises (a raised constraint would poison the transaction and
      // fail the read below). The stored outcome then says what this delivery is: 'received' is either
      // the first time or a retry whose earlier enqueue never landed — both are driven on — while any
      // final outcome is a genuine duplicate. So a transient queue failure is recoverable, not lost.
      await trx
        .table('webhook_deliveries')
        .insert({
          workspace_id: endpoint.workspace_id,
          repository_id: endpoint.repository_id,
          delivery_id: deliveryId,
          outcome: 'received',
          received_at: new Date(),
        })
        .onConflict(['repository_id', 'delivery_id'])
        .ignore()
      const stored = await trx
        .from('webhook_deliveries')
        .where({ repository_id: endpoint.repository_id, delivery_id: deliveryId })
        .first()
      if ((stored?.outcome ?? '') !== 'received') return 'duplicate'
      if (event !== 'push') return 'event_ignored'
      if (body.ref !== `refs/heads/${repository.default_ref}`) return 'ref_ignored'
      return 'queued'
    })

    if (outcome === 'queued') {
      try {
        await enqueueIngest({
          workspaceId: endpoint.workspace_id,
          repositoryId: endpoint.repository_id,
          actorUserId: endpoint.acts_as_user_id,
          trigger: 'webhook',
        })
      } catch (error) {
        // Leave the delivery at 'received' (do not fall through to the 'queued' update below) and
        // fail the request: GitHub retries the same delivery ID, which re-enters the 'received'
        // branch above and enqueues again, instead of the ingest being lost forever.
        logger.error(
          { err: error, repositoryId: endpoint.repository_id, deliveryId },
          'webhook enqueue failed; delivery left received for GitHub to retry'
        )
        return response.internalServerError({ error: 'enqueue_failed' })
      }
    }
    if (outcome !== 'duplicate' && deliveryId) {
      await inScope(scope, (trx) =>
        trx
          .from('webhook_deliveries')
          .where({ repository_id: endpoint.repository_id, delivery_id: deliveryId })
          .update({ outcome })
      )
    }
    return response.ok({ outcome })
  }
}
