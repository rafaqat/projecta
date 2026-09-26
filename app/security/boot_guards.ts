/**
 * Production boot guards (SEC-02). Test affordances are absent from
 * the production image, and if any sign of them appears at boot, the process
 * refuses to start rather than running with a mitigation disabled.
 */
export interface BootGuardInput {
  appEnv: string
  env: Record<string, string | undefined>
  allowedIssuers: string[]
  routes: string[]
  bundledModules: string[]
  testModules: string[]
  /** The database role the application connects as; absent when the database is not part of the check. */
  databaseRole?: { name: string; superuser: boolean; bypassRls: boolean }
}

export interface BootGuardResult {
  ok: boolean
  violations: string[]
}

const FORBIDDEN_FLAGS = ['MOCK_OIDC_ENABLED', 'FAKE_MODEL_ENABLED']
const EVAL_ROUTE_PREFIX = '/api/eval'

export function evaluateBootGuards(input: BootGuardInput): BootGuardResult {
  const violations: string[] = []
  // Tenancy rests on row-level security; a role that bypasses it
  // silently turns every tenant table into one. Local development may use a
  // superuser and is warned by the provider; every other environment refuses.
  const role = input.databaseRole
  if (role && input.appEnv !== 'local' && (role.superuser || role.bypassRls)) {
    violations.push(`database role ${role.name} bypasses row-level security`)
  }
  // The pinned injection classifier is configuration: an environment that falls
  // back to the rules silently would report detection it does not perform.
  if (input.appEnv !== 'local' && !input.env.INJECTION_DETECTOR_MODEL) {
    violations.push('INJECTION_DETECTOR_MODEL is not set')
  }
  if (input.appEnv !== 'production') return { ok: violations.length === 0, violations }

  for (const [name, value] of Object.entries(input.env)) {
    if (value === undefined || value === '') continue
    if (FORBIDDEN_FLAGS.includes(name) || name.startsWith('ABLATION_')) {
      violations.push(`${name} is set`)
    }
  }
  const issuer = input.env.OIDC_ISSUER ?? ''
  if (!input.allowedIssuers.includes(issuer)) {
    violations.push(`OIDC issuer is not allowlisted`)
  }
  for (const route of input.routes) {
    if (route.startsWith(EVAL_ROUTE_PREFIX)) violations.push(`eval route ${route} is registered`)
  }
  const testModules = new Set(input.testModules)
  for (const module of input.bundledModules) {
    if (testModules.has(module)) violations.push(`test module ${module} is bundled`)
  }
  return { ok: violations.length === 0, violations }
}
