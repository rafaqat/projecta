import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Extractor outputs (design §4 data model). `dependencies` and
 * `endpoints` are per-commit tenant tables under row-level security.
 * `dependency_symbols` holds the Tier 1 API surface of public registry
 * packages keyed by package and version: a public artefact shared across
 * workspaces, never repository content.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('dependencies', (table) => {
      table.uuid('id').primary()
      table.uuid('workspace_id').notNullable()
      table.uuid('commit_id').notNullable()
      table.string('ecosystem', 16).notNullable()
      table.string('name', 256).notNullable()
      table.string('version', 128).notNullable()
      table.string('kind', 16).notNullable() // direct | dev | transitive
      table.jsonb('importers').notNullable().defaultTo('[]')
      table.string('integrity', 160).nullable()
      table.string('tier1_status', 32).notNullable().defaultTo('not_fetched')
      table.unique(['commit_id', 'name'])
      table.index(['commit_id'])
    })
    this.schema.createTable('dependency_symbols', (table) => {
      table.uuid('id').primary()
      table.string('package', 256).notNullable()
      table.string('version', 128).notNullable()
      table.string('name', 256).notNullable()
      table.string('kind', 16).notNullable()
      table.string('path', 512).notNullable()
      table.integer('line').notNullable()
      table.text('declaration').notNullable()
      table.string('registry', 256).notNullable()
      table.timestamp('fetched_at').notNullable()
      table.unique(['package', 'version', 'name', 'path'])
      table.index(['package', 'version'])
    })
    this.schema.createTable('endpoints', (table) => {
      table.uuid('id').primary()
      table.uuid('workspace_id').notNullable()
      table.uuid('commit_id').notNullable()
      table.string('framework', 16).notNullable()
      table.string('method', 8).notNullable()
      table.string('path', 1024).notNullable()
      table.string('file', 1024).notNullable()
      table.integer('line').notNullable()
      table.string('handler', 256).nullable()
      table.index(['commit_id'])
    })
    this.schema.raw(`
      ALTER TABLE dependencies ADD CONSTRAINT dependencies_commit_id_fk FOREIGN KEY (commit_id) REFERENCES commits(id) ON DELETE CASCADE NOT VALID;
      ALTER TABLE endpoints ADD CONSTRAINT endpoints_commit_id_fk FOREIGN KEY (commit_id) REFERENCES commits(id) ON DELETE CASCADE NOT VALID;
    `)
    for (const table of ['dependencies', 'endpoints']) {
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
    for (const table of ['endpoints', 'dependency_symbols', 'dependencies'])
      this.schema.dropTable(table)
  }
}
