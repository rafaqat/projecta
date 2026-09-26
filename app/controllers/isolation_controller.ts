import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { inScope } from '#app/security/scope'
import WorkspaceTransformer from '#transformers/workspace_transformer'
import { assetsVersion } from '#app/assets_version'

/**
 * The Isolation checks page: the tenancy controls in effect for this workspace and their
 * state — row-level security, the workspace's honeytoken sensor, the gateway's egress boundary —
 * with the invariant each enforces. Read-only. Counts are read in the actor's scope, so they are
 * the workspace's own; the honeytoken row is checked directly (it is the sensor for a lost filter).
 */
export default class IsolationController {
  async index({ auth, scope, inertia }: HttpContext) {
    const userId = auth.getUserOrFail().id
    const workspaceId = scope.workspace.id
    const repositories = await inScope({ userId, workspaceId }, (trx) =>
      trx.from('repositories').where('workspace_id', workspaceId).count('* as n').first()
    )
    const members = await inScope({ userId, workspaceId }, (trx) =>
      trx.from('workspace_memberships').where('workspace_id', workspaceId).count('* as n').first()
    )
    // The honeytoken sensor: planted per workspace, its foreign appearance trips the gateway P1.
    const honeytoken = await db
      .from('honeytokens')
      .where('workspace_id', workspaceId)
      .count('* as n')
      .first()

    const checks = [
      {
        key: 'rls',
        label: 'Row-level security',
        state: 'on' as const,
        detail:
          'Every tenant table is read in the workspace’s scope; a query without the scope context aborts.',
        invariant: 'INV-07, INV-09',
      },
      {
        key: 'honeytoken',
        label: 'Honeytoken sensor',
        state: (Number(honeytoken?.n ?? 0) > 0 ? 'on' : 'off') as 'on' | 'off',
        detail:
          Number(honeytoken?.n ?? 0) > 0
            ? 'A decoy token is planted for this workspace; a foreign token reaching the model trips a P1 at the gateway.'
            : 'No honeytoken is planted for this workspace yet — index a repository to arm the sensor.',
        invariant: 'SEC-30',
      },
      {
        key: 'egress',
        label: 'Gateway egress boundary',
        state: 'on' as const,
        detail:
          'Only the gateway container reaches the provider; it refuses to run without a validly signed policy.',
        invariant: 'INV-02, INV-18',
      },
      {
        key: 'handles',
        label: 'Turn-local handles',
        state: 'on' as const,
        detail:
          'The model sees only handles minted this turn; a foreign handle, a bare id or a SHA renders nothing.',
        invariant: 'INV-13',
      },
      {
        key: 'caches',
        label: 'Per-workspace caches',
        state: 'on' as const,
        detail: 'Derived caches and blobs are keyed by workspace and never shared across tenants.',
        invariant: 'INV-12',
      },
    ]

    return inertia.render('isolation/index', {
      workspace: WorkspaceTransformer.transform(scope.workspace),
      repositoryCount: Number(repositories?.n ?? 0),
      memberCount: Number(members?.n ?? 0),
      checks,
      assetsVersion: assetsVersion(),
    } as never)
  }
}
