import { createHash } from 'node:crypto'
import logger from '@adonisjs/core/services/logger'
import { appMetrics } from '#app/security/telemetry/metrics'

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
  // 42704 undefined_object: the workspace's own BM25 index does not exist yet (ADR-022). A workspace
  // indexed before that change has no corpus of its own until its next ingest, and the tsvector
  // column answers correctly in the meantime — it carries no corpus statistics, so it cannot leak.
  // Narrow on purpose: the only identifier interpolated into that SQL is derived from a validated
  // workspace id, so this cannot mask a mistyped name, and every fallback is counted and logged.
  if (code === '42704') return true
  const message = error instanceof Error ? error.message : String(error)
  return /connection terminated|connection (?:closed|ended|reset)|server closed the connection|read ECONNRESET/i.test(
    message
  )
}

export interface LexicalFaultReport {
  errorCode: string
  errorHash: string
  site: string
  /** The Postgres diagnostics that say what faulted; absent on a driver-level error. */
  severity?: string
  routine?: string
  detail?: string
  where?: string
}

/**
 * What a lexical-index fault reports about itself. The fallback degrades retrieval silently, so
 * this line is the entire account of it — and it used to carry the failing SQL, because the driver
 * puts the statement on `.message`. That made 41 XX001 (data_corrupted) faults in one CI run
 * unreadable: the code was there, but nothing said which index structure raised it. The Postgres
 * diagnostic fields name that; the statement is reduced to a hash, which still joins repeats.
 */
export function lexicalFaultReport(error: unknown, site: string): LexicalFaultReport {
  const message = error instanceof Error ? error.message : String(error)
  const pg = (error ?? {}) as Record<string, unknown>
  const field = (name: string): string | undefined =>
    typeof pg[name] === 'string' && pg[name] !== '' ? (pg[name] as string) : undefined
  return {
    errorCode: field('code') ?? 'E_LEXICAL_INDEX_FAULT',
    errorHash: createHash('sha256').update(message).digest('hex').slice(0, 16),
    site,
    severity: field('severity'),
    routine: field('routine'),
    detail: field('detail'),
    where: field('where'),
  }
}

/**
 * Faults since the process started. The log line and the counter metric both leave the process; a
 * test cannot read either, and a comparison between two lexical plans is only valid if neither arm
 * degraded — so the count is readable here too.
 */
let faults = 0

export function lexicalFaultCount(): number {
  return faults
}

export function resetLexicalFaultCount(): void {
  faults = 0
}

/** Report a lexical-index fault: code, diagnostics and hash to the log, never swallowed (owner rule). */
export function reportLexicalFault(error: unknown, site: string): void {
  const report = lexicalFaultReport(error, site)
  faults++
  appMetrics.lexicalFault(report.routine ?? report.errorCode)
  logger.warn(report, 'lexical index faulted; falling back')
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
