import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The cost reconciler reads both ledgers and writes nothing: SELECT
 * on llm_usage and gateway.ledger, no INSERT, UPDATE or DELETE anywhere. The
 * role itself is created by docker/postgres/init.sql (local) and by the
 * platform (WP-14), like audit_writer and gateway.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.raw(`
      GRANT USAGE ON SCHEMA gateway TO cost_reconciler;
      GRANT SELECT ON gateway.ledger TO cost_reconciler;
      GRANT SELECT ON llm_usage TO cost_reconciler;
    `)
  }

  async down() {
    this.schema.raw(`
      REVOKE SELECT ON llm_usage FROM cost_reconciler;
      REVOKE SELECT ON gateway.ledger FROM cost_reconciler;
      REVOKE USAGE ON SCHEMA gateway FROM cost_reconciler;
    `)
  }
}
