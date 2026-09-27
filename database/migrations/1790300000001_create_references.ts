import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Resolved references: from the symbol whose body holds a call,
 * construction or read, to the symbol it resolves to at the same commit —
 * in the same file, or in another through an import — written at index
 * time from the parser's binding pass, never from text. A reference into a
 * package (an import the commit does not declare) keeps the external name
 * and no target. Per-commit tenant table under row-level security.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('symbol_references', (table) => {
      table.uuid('id').primary()
      table.uuid('workspace_id').notNullable()
      table.uuid('commit_id').notNullable()
      table.uuid('from_symbol_id').nullable()
      table.uuid('to_symbol_id').nullable()
      table.string('to_external', 512).nullable()
      table.string('kind', 16).notNullable()
      table.string('path', 1024).notNullable()
      table.integer('line').notNullable()
      table.index(['commit_id', 'to_symbol_id'])
      table.index(['commit_id', 'from_symbol_id'])
    })
    this.schema.raw(`
      ALTER TABLE symbol_references ADD CONSTRAINT symbol_references_commit_id_fk FOREIGN KEY (commit_id) REFERENCES commits(id) ON DELETE CASCADE NOT VALID;
      ALTER TABLE symbol_references ENABLE ROW LEVEL SECURITY;
      ALTER TABLE symbol_references FORCE ROW LEVEL SECURITY;
      CREATE POLICY symbol_references_workspace ON symbol_references
        USING (workspace_id = app_current_workspace_id())
        WITH CHECK (workspace_id = app_current_workspace_id());
    `)
  }

  async down() {
    this.schema.dropTable('symbol_references')
  }
}
