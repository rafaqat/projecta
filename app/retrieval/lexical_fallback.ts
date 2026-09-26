import { createHash } from 'node:crypto'
import logger from '@adonisjs/core/services/logger'

/**
 * Resilience for the lexical retriever. `pg_textsearch` is a third-party BM25 extension
 * built from source (docker/postgres/Dockerfile) and is not on Azure's allowlist; it can abort a
 * query with an internal error (SQLSTATE class `XX`, e.g. `XX001 data_corrupted`) or drop the
 * connection. The same content is indexed a second time as a native `tsvector`/GIN column so
 * `LEXICAL_BACKEND` can switch without re-indexing (migration 1789400000001, README "one real
 * migration trade to call out"). When the BM25 index faults we take that same switch automatically
 * for the one query, rather than fail the whole turn.
 */

/**
 * True only for faults that mean the BM25 index itself failed — its internal errors (`XX*`) or the
 * connection dropping under it (`08*`, `57P0*`, or the driver reporting the socket gone). A bug in
 * OUR own SQL (syntax `42*`, bad data `22*`, integrity `23*`) is deliberately NOT caught here, so a
 * real query defect still surfaces instead of being masked by a silent fallback.
 */
export function isLexicalIndexFault(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  if (typeof code === 'string' && (/^XX/.test(code) || /^08/.test(code) || /^57P0/.test(code))) {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return /connection terminated|connection (?:closed|ended|reset)|server closed the connection|read ECONNRESET/i.test(
    message
  )
}

/** Report a lexical-index fault: code + hash to the log, never swallowed (owner rule). */
export function reportLexicalFault(error: unknown, site: string): void {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'E_LEXICAL_INDEX_FAULT'
  const hash = createHash('sha256').update(message).digest('hex').slice(0, 16)
  logger.warn(
    { errorCode: code, errorHash: hash, site, message: message.slice(0, 240) },
    'lexical index faulted; falling back'
  )
}

/**
 * Run the primary lexical query; on a BM25-index fault, report it and run the fallback. Any other
 * error (a real bug in our SQL) propagates unchanged.
 */
export async function withLexicalFallback<T>(
  site: string,
  primary: () => Promise<T>,
  fallback: () => Promise<T>
): Promise<T> {
  try {
    return await primary()
  } catch (error) {
    if (!isLexicalIndexFault(error)) throw error
    reportLexicalFault(error, site)
    return fallback()
  }
}
