import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * `node ace workspace:create --name UAT --owner someone@example.test`
 * provisions a workspace for a person who has already signed in, with that
 * person as its owner, and prints the handle. Operator's action: there is
 * no page for it (UAT 2026-09-14).
 */
export default class WorkspaceCreate extends BaseCommand {
  static commandName = 'workspace:create'
  static description = 'Create a workspace owned by an existing (signed-in) user'
  static options: CommandOptions = { startApp: true }

  @flags.string({ description: 'Workspace name', required: true })
  declare name: string

  @flags.string({
    description: 'Email of the owner, who must have signed in before',
    required: true,
  })
  declare owner: string

  async run() {
    // Imported here, not at the top: ace loads every command file to list them.
    const { createWorkspace } = await import('#app/workspaces/provision')
    try {
      const { handle } = await createWorkspace({ name: this.name, ownerEmail: this.owner })
      this.logger.success(`workspace "${this.name}" created: /w/${handle} (owner ${this.owner})`)
    } catch (error) {
      this.logger.error((error as Error).message)
      this.exitCode = 1
    }
  }
}
