import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Clone intelligence outputs (design §7): classes and
 * members per commit, and per-workspace LSH band signatures so "find
 * similar code" can look across a workspace's active commits. All three are
 * tenant tables under row-level security; repository ACL is enforced by
 * joining through `commits` to the RLS-filtered `repositories` table.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('clone_classes', (table) => {
      table.uuid('id').primary()
      table.uuid('workspace_id').notNullable()
      table.uuid('commit_id').notNullable()
      table.smallint('type').notNullable()
      table.string('classification', 16).notNullable() // duplicate | pattern
      table.string('method', 32).notNullable()
      table.float('similarity').notNullable()
      table.integer('size').notNullable()
      table.index(['commit_id'])
    })
    this.schema.createTable('clone_members', (table) => {
      table.uuid('id').primary()
      table.uuid('workspace_id').notNullable()
      table.uuid('class_id').notNullable()
      table.string('path', 1024).notNullable()
      table.string('qualified_name', 512).notNullable()
      table.integer('start_line').notNullable()
      table.integer('end_line').notNullable()
      table.integer('tokens').notNullable()
      table.jsonb('divergence').notNullable().defaultTo('[]')
      table.index(['class_id'])
    })
    this.schema.createTable('clone_signatures', (table) => {
      table.uuid('id').primary()
      table.uuid('workspace_id').notNullable()
      table.uuid('commit_id').notNullable()
      table.string('path', 1024).notNullable()
      table.string('qualified_name', 512).notNullable()
      table.integer('start_line').notNullable()
      table.integer('end_line').notNullable()
      table.string('band', 40).notNullable()
      table.index(['workspace_id', 'band'])
      table.index(['commit_id', 'path', 'qualified_name'])
    })
    this.schema.raw(`
      ALTER TABLE clone_classes ADD CONSTRAINT clone_classes_commit_id_fk FOREIGN KEY (commit_id) REFERENCES commits(id) ON DELETE CASCADE NOT VALID;
      ALTER TABLE clone_members ADD CONSTRAINT clone_members_class_id_fk FOREIGN KEY (class_id) REFERENCES clone_classes(id) ON DELETE CASCADE NOT VALID;
      ALTER TABLE clone_signatures ADD CONSTRAINT clone_signatures_commit_id_fk FOREIGN KEY (commit_id) REFERENCES commits(id) ON DELETE CASCADE NOT VALID;
    `)
    for (const table of ['clone_classes', 'clone_members', 'clone_signatures']) {
      this.schema.raw(`
        ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
        CREATE POLICY ${table}_workspace ON ${table}
          USING (workspace_id = app_current_workspace_id())
          WITH CHECK (workspace_id = app_current_workspace_id());
      `)
    }
  }

  async down() {
    for (const table of ['clone_signatures', 'clone_members', 'clone_classes'])
      this.schema.dropTable(table)
  }
}
