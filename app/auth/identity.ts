import User from '#models/user'
import type { IdentityClaims } from '#app/auth/oidc_client'

/**
 * Users are keyed by (tid, oid) and never by email (SEC-11): a
 * changed email updates the same account; a different oid with the same
 * email is a different person.
 */
export async function findOrCreateUser(claims: IdentityClaims): Promise<User> {
  const existing = await User.query().where({ tid: claims.tid, oid: claims.oid }).first()
  const email = claims.email ?? `${claims.oid}@${claims.tid}.invalid`
  if (existing) {
    existing.merge({ email, fullName: claims.name ?? existing.fullName })
    if (existing.$isDirty) await existing.save()
    return existing
  }
  return User.create({ tid: claims.tid, oid: claims.oid, email, fullName: claims.name ?? null })
}
