import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * BOM share links (WP-23). Two tables, split the way `webhook_endpoints` is:
 *
 * - `bom_share_links`, the link record, is a tenant table under forced row-level security like
 *   every other: listing and revoking happen inside the reader's scope.
 * - `bom_share_routes` is outside row-level security on purpose. The public route has no session
 *   and so no scope to enter until it knows whose link it is; this table tells it, and holds only
 *   the token's SHA-256 and the ids needed to enter that scope — nothing a tenant would mind being
 *   read by the route that exists to read it.
 *
 * No column anywhere holds a plaintext token (AC-WP23-06). Forward-only.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('bom_share_links', (table) => {
      table.uuid('id').primary()
      table.string('handle', 16).notNullable().unique()
      table.uuid('workspace_id').notNullable()
      table.uuid('repository_id').notNullable()
      table.uuid('turn_id').notNullable()
      table.uuid('commit_id').notNullable()
      table.string('format', 16).notNullable()
      table.integer('created_by').notNullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('expires_at').notNullable()
      table.timestamp('revoked_at').nullable()
      table.integer('revoked_by').nullable()
      table.index(['turn_id', 'created_by'])
    })
    this.schema.createTable('bom_share_routes', (table) => {
      table.string('token_hash', 64).primary()
      table.uuid('link_id').notNullable().unique()
      table.uuid('workspace_id').notNullable()
      table.integer('acts_as_user_id').notNullable()
    })
    this.schema.raw(`
      ALTER TABLE bom_share_links ENABLE ROW LEVEL SECURITY;
      ALTER TABLE bom_share_links FORCE ROW LEVEL SECURITY;
      CREATE POLICY bom_share_links_workspace ON bom_share_links
        USING (workspace_id = app_current_workspace_id())
        WITH CHECK (workspace_id = app_current_workspace_id());
    `)
  }

  async down() {
    this.schema.dropTable('bom_share_routes')
    this.schema.dropTable('bom_share_links')
  }
}
