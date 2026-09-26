import { BasePolicy } from '@adonisjs/bouncer'
import type { AuthorizerResponse } from '@adonisjs/bouncer/types'
import type User from '#models/user'
import type Repository from '#models/repository'
import RepositoryMember from '#models/repository_member'
import WorkspaceMembership from '#models/workspace_membership'
import { inScope } from '#app/security/scope'
import { faultInjected } from '#app/security/ablation_switch'

/**
 * Repository ACL (SEC-05): a workspace member may view a
 * `workspace`-visible repository; a `restricted` one needs explicit
 * repository membership.
 */
export default class RepositoryPolicy extends BasePolicy {
  async view(user: User, repository: Repository): Promise<AuthorizerResponse> {
    await faultInjected('policy_evaluation')
    const member = await inScope({ userId: user.id }, (trx) =>
      WorkspaceMembership.query({ client: trx })
        .where({ workspaceId: repository.workspaceId, userId: user.id })
        .first()
    )
    if (!member) return false
    if (repository.visibility === 'workspace') return true
    const explicit = await inScope(
      { userId: user.id, workspaceId: repository.workspaceId },
      (trx) =>
        RepositoryMember.query({ client: trx })
          .where({ repositoryId: repository.id, userId: user.id })
          .first()
    )
    return explicit !== null
  }
}
