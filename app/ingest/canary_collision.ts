import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { honeytokenHmac } from '#app/ingest/indexer'

/**
 * Repository content that carries a value the gateway's outbound rules hold
 * (the system-prompt canary, a planted honeytoken) is refused at index time
 * (WP-19, BL-05). Otherwise every answer citing it would be held by the
 * canary or honeytoken rule with nothing naming the cause. Honeytokens are
 * compared by HMAC, so the check never learns another workspace's token.
 */
const HONEYTOKEN_SHAPE = /HT-[0-9a-f]{24}/g

export async function collidesWithCanary(
  trx: TransactionClientContract,
  content: Buffer
): Promise<boolean> {
  const text = content.toString('utf8')
  const canary = process.env.SYSTEM_PROMPT_CANARY
  if (canary && text.includes(canary)) return true
  const candidates = [...new Set(Array.from(text.matchAll(HONEYTOKEN_SHAPE), (m) => m[0]))]
  if (candidates.length === 0) return false
  const hit = await trx
    .from('gateway.honeytoken_hmacs')
    .whereIn('hmac', candidates.map(honeytokenHmac))
    .first()
  return hit !== null && hit !== undefined
}
