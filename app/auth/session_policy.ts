/**
 * Session lifecycle (SEC-37): the owner kept the plan's defaults
 * on 2026-09-11. Timestamps are kept in the server-side session store.
 */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000
export const ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000

export const SESSION_STARTED_AT = 'auth_started_at'
export const SESSION_LAST_SEEN_AT = 'auth_last_seen_at'

/** Injectable clock so lifecycle tests can move time without waiting. */
export const clock = { now: () => Date.now() }

export type SessionVerdict = 'valid' | 'idle_expired' | 'absolute_expired' | 'untracked'

export function judgeSession(startedAt: unknown, lastSeenAt: unknown, now: number): SessionVerdict {
  if (typeof startedAt !== 'number' || typeof lastSeenAt !== 'number') return 'untracked'
  if (now - startedAt > ABSOLUTE_TIMEOUT_MS) return 'absolute_expired'
  if (now - lastSeenAt > IDLE_TIMEOUT_MS) return 'idle_expired'
  return 'valid'
}
