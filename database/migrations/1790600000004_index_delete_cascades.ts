import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Indexes for the two foreign keys on the repository-delete path that had none: deleting a symbol sets chunk.symbol_id to null; Postgres
 * finds those rows by the foreign-key column, and without an index each parent row cost a full
 * scan — 104 tiny repositories took eleven minutes to delete (2026-09-20). Built concurrently so
 * applying this to a live stack does not lock a table the worker is writing. Forward-only.
 */
export default class extends BaseSchema {
  static disableTransactions = true

  async up() {
    this.schema.raw(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS chunks_symbol_id_index ON chunks (symbol_id)'
    )
  }

  async down() {
    this.schema.raw('DROP INDEX CONCURRENTLY IF EXISTS chunks_symbol_id_index')
  }
}
