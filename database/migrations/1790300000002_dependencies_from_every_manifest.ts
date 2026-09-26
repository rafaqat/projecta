import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Dependencies from every manifest at the commit. A dependency row
 * names the manifest and line it was read from, so one name declared by
 * several manifests (a monorepo's packages, a Gradle build's modules) keeps
 * one row each. `manifests` records every manifest the index recognised at
 * the commit — read, with the rows it yielded, or unread — so an answer can
 * say what was not read instead of "none". Per-commit tenant table under
 * row-level security.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('dependencies', (table) => {
      table.string('manifest', 1024).notNullable().defaultTo('')
      table.integer('line').nullable()
      table.dropUnique(['commit_id', 'name'])
      table.unique(['commit_id', 'ecosystem', 'name', 'manifest'])
    })
    this.schema.createTable('manifests', (table) => {
      table.uuid('id').primary()
      table.uuid('workspace_id').notNullable()
      table.uuid('commit_id').notNullable()
      table.string('path', 1024).notNullable()
      table.string('ecosystem', 16).notNullable()
      table.string('status', 8).notNullable() // read | unread
      table.integer('dependencies').notNullable().defaultTo(0)
      table.unique(['commit_id', 'path'])
    })
    this.schema.raw(`
      ALTER TABLE manifests ADD CONSTRAINT manifests_commit_id_fk FOREIGN KEY (commit_id) REFERENCES commits(id) ON DELETE CASCADE NOT VALID;
      ALTER TABLE manifests ENABLE ROW LEVEL SECURITY;
      ALTER TABLE manifests FORCE ROW LEVEL SECURITY;
      CREATE POLICY manifests_workspace ON manifests
        USING (workspace_id = app_current_workspace_id())
        WITH CHECK (workspace_id = app_current_workspace_id());
    `)
  }

  async down() {
    this.schema.dropTable('manifests')
    this.schema.alterTable('dependencies', (table) => {
      table.dropUnique(['commit_id', 'ecosystem', 'name', 'manifest'])
      table.unique(['commit_id', 'name'])
      table.dropColumn('line')
      table.dropColumn('manifest')
    })
  }
}
