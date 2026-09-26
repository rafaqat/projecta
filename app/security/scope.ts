import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

export interface Scope {
  userId: number
  workspaceId?: string
}

/**
 * Runs `fn` inside a transaction whose row-level security context is set
 * with SET LOCAL semantics. Outside this helper every query on a
 * tenant table aborts, because the policies call functions that raise when
 * the settings are absent.
 */
export async function inScope<T>(
  scope: Scope,
  fn: (trx: TransactionClientContract) => Promise<T>
): Promise<T> {
  return db.transaction(async (trx) => {
    await trx.rawQuery(
      `select set_config('app.user_id', ?, true), set_config('app.workspace_id', ?, true)`,
      [String(scope.userId), scope.workspaceId ?? '']
    )
    return fn(trx)
  })
}
