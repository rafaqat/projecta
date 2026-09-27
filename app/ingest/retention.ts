import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

/**
 * Retention (design §4): commits that are neither active nor referenced by
 * a decision record are removed after the policy period. Decision records
 * arrive in WP-07, so this skeleton only selects candidates; the daily job
 * that calls it is registered by the worker.
 */
export const RETENTION_DAYS = 30

export async function retentionCandidates(
  trx: TransactionClientContract,
  workspaceId: string,
  now = new Date()
) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
  return trx
    .from('commits')
    .where('commits.workspace_id', workspaceId)
    .where('commits.created_at', '<', cutoff)
    .whereNotExists((query) => {
      query.from('repositories').whereRaw('repositories.active_commit_id = commits.id')
    })
    .select('commits.id', 'commits.sha', 'commits.repository_id')
}
