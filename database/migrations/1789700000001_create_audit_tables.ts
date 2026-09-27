import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Attribution and audit (design §8-9). `llm_usage` is the
 * per-call ledger. `audit_outbox` is written by the app in the transaction
 * that completes a turn; `audit_events` is the per-workspace hash chain that
 * only the audit_writer role may append to, with a trigger refusing updates
 * and deletes for everyone. `audit_anchors` mirrors what was anchored to
 * write-once storage. `turn_citations` records which code was shown to whom.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('llm_usage', (table) => {
      table.uuid('id').primary()
      table.uuid('workspace_id').notNullable()
      table.integer('user_id').notNullable()
      table.string('request_id', 64).notNullable()
      table.string('turn_handle', 16).nullable()
      table.string('purpose', 32).notNullable()
      table.string('model', 64).notNullable()
      table.string('status', 16).notNullable()
      table.integer('input_tokens').nullable()
      table.integer('output_tokens').nullable()
      table.integer('cache_read_tokens').nullable()
      table.integer('cache_creation_tokens').nullable()
      table.timestamp('started_at').notNullable()
      table.timestamp('ended_at').nullable()
      table.index(['workspace_id', 'started_at'])
    })
    this.schema.createTable('audit_outbox', (table) => {
      table.bigIncrements('id')
      table.uuid('workspace_id').notNullable()
      table.string('event', 48).notNullable()
      table.jsonb('payload').notNullable()
      table.timestamp('created_at').notNullable().defaultTo(this.raw('clock_timestamp()'))
    })
    this.schema.createTable('audit_events', (table) => {
      table.uuid('workspace_id').notNullable()
      table.bigInteger('seq').notNullable()
      table.string('event', 48).notNullable()
      table.jsonb('payload').notNullable()
      table.timestamp('occurred_at').notNullable()
      table.string('prev_hash', 64).notNullable()
      table.string('hash', 64).notNullable()
      table.uuid('batch_id').notNullable()
      table.primary(['workspace_id', 'seq'])
    })
    this.schema.createTable('audit_batches', (table) => {
      table.uuid('id').primary()
      table.uuid('workspace_id').notNullable()
      table.bigInteger('from_seq').notNullable()
      table.bigInteger('to_seq').notNullable()
      table.string('head_hash', 64).notNullable()
      table.text('signature').notNullable()
      table.string('key_id', 64).notNullable()
      table.timestamp('written_at').notNullable()
    })
    this.schema.createTable('audit_anchors', (table) => {
      table.uuid('id').primary()
      table.uuid('workspace_id').notNullable()
      table.bigInteger('seq').notNullable()
      table.string('head_hash', 64).notNullable()
      table.text('location').notNullable()
      table.timestamp('anchored_at').notNullable()
    })
    this.schema.createTable('turn_citations', (table) => {
      table.uuid('id').primary()
      table.uuid('workspace_id').notNullable()
      table.uuid('turn_id').notNullable()
      table.string('handle', 8).notNullable()
      table.string('commit_sha', 64).notNullable()
      table.string('blob_sha', 64).notNullable()
      table.text('path').notNullable()
      table.integer('start_line').notNullable()
      table.integer('end_line').notNullable()
      table.string('span_sha256', 64).notNullable()
      table.index(['turn_id'])
    })
    this.schema.alterTable('turns', (table) => {
      table.string('question_salt', 64).nullable()
      table.string('answer_salt', 64).nullable()
      table.string('withheld_salt', 64).nullable()
      table.string('config_hash', 64).nullable()
      table.timestamp('erased_at').nullable()
    })
    this.schema.raw(`
      ALTER TABLE turn_citations ADD CONSTRAINT turn_citations_turn_id_fk FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE NOT VALID;
    `)
    for (const table of [
      'llm_usage',
      'audit_outbox',
      'audit_events',
      'audit_batches',
      'audit_anchors',
      'turn_citations',
    ]) {
      this.schema.raw(`
        ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
        CREATE POLICY ${table}_workspace ON ${table}
          USING (workspace_id = app_current_workspace_id())
          WITH CHECK (workspace_id = app_current_workspace_id());
      `)
    }
    // Write authority: the app role reads the chain and feeds the outbox; only audit_writer appends.
    this.schema.raw(`
      REVOKE INSERT, UPDATE, DELETE ON audit_events, audit_batches, audit_anchors FROM app;
      GRANT SELECT ON audit_events, audit_batches, audit_anchors TO app;
      GRANT SELECT, UPDATE, DELETE ON audit_outbox TO audit_writer;
      GRANT SELECT, INSERT ON audit_events, audit_batches, audit_anchors TO audit_writer;
      GRANT SELECT ON workspaces TO audit_writer;
      CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'audit_events is append-only';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
      CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
        FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();
    `)
  }

  async down() {
    for (const table of [
      'turn_citations',
      'audit_anchors',
      'audit_batches',
      'audit_events',
      'audit_outbox',
      'llm_usage',
    ]) {
      this.schema.dropTable(table)
    }
    this.schema.alterTable('turns', (table) => {
      table.dropColumns('question_salt', 'answer_salt', 'withheld_salt', 'config_hash', 'erased_at')
    })
    this.schema.raw('DROP FUNCTION IF EXISTS audit_events_immutable()')
  }
}
