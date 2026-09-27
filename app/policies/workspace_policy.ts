import { BasePolicy } from '@adonisjs/bouncer'
import type { AuthorizerResponse } from '@adonisjs/bouncer/types'
import type User from '#models/user'
import type Workspace from '#models/workspace'
import WorkspaceMembership from '#models/workspace_membership'
import { inScope } from '#app/security/scope'
import { faultInjected } from '#app/security/ablation_switch'

function membershipOf(user: User, workspace: Workspace) {
  return inScope({ userId: user.id }, (trx) =>
    WorkspaceMembership.query({ client: trx })
      .where({ workspaceId: workspace.id, userId: user.id })
      .first()
  )
}

/**
 * Workspace access: membership decides. The lookup runs in the
 * user's own scope, so row-level security agrees with the answer.
 */
export default class WorkspacePolicy extends BasePolicy {
  async view(user: User, workspace: Workspace): Promise<AuthorizerResponse> {
    await faultInjected('policy_evaluation')
    return (await membershipOf(user, workspace)) !== null
  }

  /** Registering repositories and changing members needs the owner role. */
  async manage(user: User, workspace: Workspace): Promise<AuthorizerResponse> {
    await faultInjected('policy_evaluation')
    const membership = await membershipOf(user, workspace)
    return membership?.role === 'owner'
  }
}
