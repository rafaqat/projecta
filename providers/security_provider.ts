import { readFile } from 'node:fs/promises'
import type { ApplicationService } from '@adonisjs/core/types'
import env from '#start/env'
import { evaluateBootGuards } from '#app/security/boot_guards'

/**
 * Runs the production boot guards once routes are registered (ADR-020). A
 * violation is fatal: the process exits non-zero before serving a request.
 */
export default class SecurityProvider {
  constructor(protected app: ApplicationService) {}

  async ready() {
    const input = await this.collectBootGuardInput()
    const result = evaluateBootGuards(input)
    const logger = await this.app.container.make('logger')
    if (input.databaseRole && (input.databaseRole.superuser || input.databaseRole.bypassRls)) {
      logger.warn(
        { role: input.databaseRole.name },
        'database role bypasses row-level security; tenancy relies on application scope alone'
      )
    }
    if (result.ok) return
    for (const violation of result.violations) logger.fatal({ violation }, 'boot guard violation')
    await this.app.terminate()
    process.exit(1)
  }

  async collectBootGuardInput() {
    const router = await this.app.container.make('router')
    const routes = Object.values(router.toJSON())
      .flat()
      .map((route) => route.pattern)
    return {
      // Only processes that serve tenant data are held to the role guard: the HTTP server and
      // the ingest worker. An ace command (policy signing, docs) may run with no database at all.
      databaseRole: this.servesTenantData() ? await this.databaseRole() : undefined,
      appEnv: env.get('APP_ENV'),
      env: process.env,
      allowedIssuers: env
        .get('OIDC_ALLOWED_ISSUERS')
        .split(',')
        .map((s) => s.trim()),
      routes,
      bundledModules: await readJsonList(this.app.makePath('build-manifest.json'), 'modules'),
      testModules: await readJsonList(this.app.makePath('test-modules.json'), 'modules'),
    }
  }

  private servesTenantData(): boolean {
    const environment = this.app.getEnvironment()
    return environment === 'web' || environment === 'test' || process.env.APP_PROCESS === 'worker'
  }

  /**
   * The role the application connects as. A role that cannot be verified is
   * reported as bypassing, so an unreachable or misconfigured database fails
   * the guard explicitly instead of crashing the boot for an unrelated reason.
   */
  private async databaseRole() {
    try {
      const db = await this.app.container.make('lucid.db')
      const result = await db.rawQuery(
        'select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user'
      )
      const row = result.rows[0] as
        { rolname: string; rolsuper: boolean; rolbypassrls: boolean } | undefined
      if (!row) return { name: 'unknown', superuser: true, bypassRls: true }
      return { name: row.rolname, superuser: row.rolsuper, bypassRls: row.rolbypassrls }
    } catch (error) {
      const logger = await this.app.container.make('logger')
      logger.error({ err: error }, 'database role could not be verified at boot')
      return { name: 'unverified', superuser: true, bypassRls: true }
    }
  }
}

async function readJsonList(path: string, key: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    const list = parsed[key]
    return Array.isArray(list) ? list.map(String) : []
  } catch {
    return []
  }
}
