import env from '#start/env'

const TEST_ENVS = ['local', 'test']

/**
 * Production-safe view of the ablations. Outside local and test the answer
 * is always false, and the ablation module itself is absent from production
 * images, so this cannot be flipped by configuration alone.
 */
export async function isAblated(name: string): Promise<boolean> {
  if (!TEST_ENVS.includes(env.get('APP_ENV'))) return false
  try {
    const ablations = await import('#app/security/ablations')
    return ablations.activeAblations().has(name as never)
  } catch {
    return false
  }
}

/**
 * Fault injection for fail-closed tests (SEC-39). Throws only when the
 * test-only module is present and the fault is armed; a no-op in production.
 */
export async function faultInjected(name: string): Promise<void> {
  if (!TEST_ENVS.includes(env.get('APP_ENV'))) return
  try {
    const ablations = await import('#app/security/ablations')
    ablations.throwIfFaultArmed(name)
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') return
    throw error
  }
}

/** A test seam value, or undefined outside local and test. */
export async function testSeam<T>(name: string): Promise<T | undefined> {
  if (!TEST_ENVS.includes(env.get('APP_ENV'))) return undefined
  try {
    const ablations = await import('#app/security/ablations')
    return ablations.testSeams[name] as T | undefined
  } catch {
    return undefined
  }
}
