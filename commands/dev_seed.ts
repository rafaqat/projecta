import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * `node ace dev:seed` (run by `make setup`): the dev identities of the mock
 * provider and the Keycloak realm, and the "Local" workspace they belong to,
 * so the first sign-in lands in a workspace. Local stack only; idempotent.
 */
export default class DevSeed extends BaseCommand {
  static commandName = 'dev:seed'
  static description =
    'Seed the local stack: dev identities and the "Local" workspace (APP_ENV=local only)'
  static options: CommandOptions = { startApp: true }

  async run() {
    // Imported here, not at the top: ace loads every command file to list them.
    const { seedLocalWorkspace } = await import('#app/workspaces/dev_seed')
    const { default: env } = await import('#start/env')
    try {
      const { users, workspace } = await seedLocalWorkspace({ appEnv: env.get('APP_ENV') })
      for (const user of users) this.logger.info(`${user.provider} ${user.oid} → ${user.role}`)
      this.logger.success(
        `${workspace.created ? 'created' : 'kept'} workspace "${workspace.name}": /w/${workspace.handle}`
      )
    } catch (error) {
      this.logger.error((error as Error).message)
      this.exitCode = 1
    }
  }
}
