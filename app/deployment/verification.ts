import type { KeyObject } from 'node:crypto'
import type { Pool } from 'pg'
import db from '@adonisjs/lucid/services/db'
import { keyId } from '#app/audit/signing'
import type { Verification } from '#app/deployment/about'

/**
 * Records a verdict of `audit:verify`. Takes the audit_writer pool the command already
 * holds: the web role is not granted INSERT on this table, so only a verification can record one.
 * A failed verification is recorded too — "failed 2 hours ago" is the point of the badge.
 */
export async function recordVerification(
  pool: Pool,
  verdict: { ok: boolean; publicKey: KeyObject }
): Promise<void> {
  await pool.query('insert into audit_verifications (ok, key_id) values ($1, $2)', [
    verdict.ok,
    keyId(verdict.publicKey),
  ])
}

/** The latest recorded verdict, read by the web role; null when none was ever recorded. */
export async function lastVerification(): Promise<Verification | null> {
  const row = (await db
    .from('audit_verifications')
    .orderBy('verified_at', 'desc')
    .select('verified_at', 'ok', 'key_id')
    .first()) as { verified_at: Date; ok: boolean; key_id: string } | null
  return row ? { verifiedAt: new Date(row.verified_at), ok: row.ok, keyId: row.key_id } : null
}
