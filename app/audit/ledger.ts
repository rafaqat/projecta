import type { GatewayDecisions } from '#guards/index'
import { randomUUID } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import type { Signer } from '#app/security/attribution'

/**
 * The llm_usage ledger (design §8): exactly one row per provider call,
 * written outside the turn transaction so it survives cancellation and
 * failure. Token counts come from the provider's message_start and
 * message_delta events; no prompt or answer text is ever stored (INV-04).
 */
export interface CallContext {
  userId: number
  workspaceId: string
  requestId: string
  purpose: 'answer' | 'scope_classification'
  turnHandle?: string
  signer?: Signer
  /**
   * What the gateway reported it did. Recorded, never branched on: the gateway
   * enforces and the application keeps what it was told, so the drawer can answer "what did the
   * gateway check" without shell access to the container.
   */
  onGatewayDecisions?: (decisions: GatewayDecisions) => void
}

export interface Usage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

export type CallStatus = 'running' | 'completed' | 'cancelled' | 'failed'

function scoped<T>(
  ctx: CallContext,
  fn: (trx: import('@adonisjs/lucid/types/database').TransactionClientContract) => Promise<T>
) {
  return db.transaction(async (trx) => {
    await trx.rawQuery(
      `select set_config('app.user_id', ?, true), set_config('app.workspace_id', ?, true)`,
      [String(ctx.userId), ctx.workspaceId]
    )
    return fn(trx)
  })
}

export async function openLedgerRow(
  ctx: CallContext,
  model: string,
  jti?: string
): Promise<string> {
  const id = randomUUID()
  await scoped(ctx, (trx) =>
    trx.table('llm_usage').insert({
      id,
      workspace_id: ctx.workspaceId,
      user_id: ctx.userId,
      request_id: ctx.requestId,
      turn_handle: ctx.turnHandle ?? null,
      purpose: ctx.purpose,
      model,
      jti: jti ?? null,
      status: 'running',
      started_at: new Date(),
    })
  )
  return id
}

export async function updateLedgerRow(
  ctx: CallContext,
  id: string,
  usage: Usage,
  status?: CallStatus
): Promise<void> {
  await scoped(ctx, (trx) =>
    trx
      .from('llm_usage')
      .where('id', id)
      .update({
        ...(usage.inputTokens !== undefined ? { input_tokens: usage.inputTokens } : {}),
        ...(usage.outputTokens !== undefined ? { output_tokens: usage.outputTokens } : {}),
        ...(usage.cacheReadTokens !== undefined
          ? { cache_read_tokens: usage.cacheReadTokens }
          : {}),
        ...(usage.cacheCreationTokens !== undefined
          ? { cache_creation_tokens: usage.cacheCreationTokens }
          : {}),
        ...(status ? { status, ended_at: new Date() } : {}),
      })
  )
}
