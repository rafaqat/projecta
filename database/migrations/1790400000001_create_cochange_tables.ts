import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Files that change together, from history fetched without
 * contents. `file_cochanges` holds one row per kept pair at a commit
 * (`path_a < path_b` in byte order, as the ingest sorts them); `commit_history` records whether history was indexed
 * for the commit and, when not, why — so a tool says "history not indexed",
 * never "no companions". Neither stores a person, a date or a message. Both
 * are per-commit tenant tables under forced row-level security.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('file_cochanges', (table) => {
      table.uuid('workspace_id').notNullable()
      table.uuid('commit_id').notNullable()
      table.string('path_a', 1024).notNullable()
      table.string('path_b', 1024).notNullable()
      table.integer('together').notNullable()
      table.integer('changes_a').notNullable()
      table.integer('changes_b').notNullable()
      table.primary(['commit_id', 'path_a', 'path_b'])
      table.index(['commit_id', 'path_b'])
    })
    this.schema.createTable('commit_history', (table) => {
      table.uuid('workspace_id').notNullable()
      table.uuid('commit_id').primary()
      table.string('status', 16).notNullable() // indexed | not_indexed
      table.string('reason_code', 32).nullable()
      table.integer('commits_read').notNullable().defaultTo(0)
      table.integer('bulk_skipped').notNullable().defaultTo(0)
      table.timestamp('recorded_at').notNullable()
    })
    this.schema.raw(`
      ALTER TABLE file_cochanges ADD CONSTRAINT file_cochanges_ordered CHECK (path_a COLLATE "C" < path_b COLLATE "C");
      ALTER TABLE file_cochanges ADD CONSTRAINT file_cochanges_counts CHECK (together > 0 AND together <= changes_a AND together <= changes_b);
      ALTER TABLE file_cochanges ADD CONSTRAINT file_cochanges_commit_id_fk FOREIGN KEY (commit_id) REFERENCES commits(id) ON DELETE CASCADE NOT VALID;
      ALTER TABLE file_cochanges ADD CONSTRAINT file_cochanges_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;
      ALTER TABLE file_cochanges ENABLE ROW LEVEL SECURITY;
      ALTER TABLE file_cochanges FORCE ROW LEVEL SECURITY;
      CREATE POLICY file_cochanges_workspace ON file_cochanges
        USING (workspace_id = app_current_workspace_id())
        WITH CHECK (workspace_id = app_current_workspace_id());

      ALTER TABLE commit_history ADD CONSTRAINT commit_history_status CHECK (status IN ('indexed', 'not_indexed'));
      ALTER TABLE commit_history ADD CONSTRAINT commit_history_reason CHECK ((status = 'indexed') = (reason_code IS NULL));
      ALTER TABLE commit_history ADD CONSTRAINT commit_history_commit_id_fk FOREIGN KEY (commit_id) REFERENCES commits(id) ON DELETE CASCADE NOT VALID;
      ALTER TABLE commit_history ADD CONSTRAINT commit_history_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;
      ALTER TABLE commit_history ENABLE ROW LEVEL SECURITY;
      ALTER TABLE commit_history FORCE ROW LEVEL SECURITY;
      CREATE POLICY commit_history_workspace ON commit_history
        USING (workspace_id = app_current_workspace_id())
        WITH CHECK (workspace_id = app_current_workspace_id());
    `)
  }

  async down() {
    this.schema.dropTable('commit_history')
    this.schema.dropTable('file_cochanges')
  }
}
