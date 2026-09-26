import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The gateway's own schema and role: an independent
 * ledger the app can read for reconciliation but not write, and the
 * honeytoken HMAC table the app fills at plant time so the gateway can
 * recognise foreign tokens without holding plaintext (SEC-30).
 */
export default class extends BaseSchema {
  async up() {
    this.schema.raw(`
      CREATE SCHEMA IF NOT EXISTS gateway;
      CREATE TABLE gateway.ledger (
        id uuid PRIMARY KEY,
        jti text NOT NULL UNIQUE,
        sub text NOT NULL,
        workspace_id text NOT NULL,
        purpose text NOT NULL,
        model text NOT NULL,
        route text NOT NULL,
        signer text NOT NULL,
        status text NOT NULL,
        input_tokens integer,
        output_tokens integer,
        rule text,
        started_at timestamptz NOT NULL,
        ended_at timestamptz
      );
      CREATE TABLE gateway.honeytoken_hmacs (
        workspace_id uuid PRIMARY KEY,
        hmac text NOT NULL UNIQUE
      );
      GRANT USAGE ON SCHEMA gateway TO gateway;
      GRANT SELECT, INSERT, UPDATE ON gateway.ledger TO gateway;
      GRANT SELECT ON gateway.honeytoken_hmacs TO gateway;
      REVOKE INSERT, UPDATE, DELETE ON gateway.ledger FROM app;
      GRANT SELECT ON gateway.ledger TO app;
      -- Reconciliation reads every workspace: the audit_writer role (BYPASSRLS) does it, read-only.
      GRANT USAGE ON SCHEMA gateway TO audit_writer;
      GRANT SELECT ON gateway.ledger TO audit_writer;
      GRANT SELECT ON llm_usage, sessions TO audit_writer;
    `)
    // The app ledger records the token id so the two ledgers reconcile by jti.
    this.schema.alterTable('llm_usage', (table) => {
      table.string('jti', 64).nullable().index()
    })
  }

  async down() {
    this.schema.alterTable('llm_usage', (table) => {
      table.dropColumn('jti')
    })
    this.schema.raw('DROP SCHEMA IF EXISTS gateway CASCADE')
  }
}
