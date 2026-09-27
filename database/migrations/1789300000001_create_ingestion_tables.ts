import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Commit and content addressing. Blobs are keyed
 * by (workspace_id, blob_sha) and never shared across workspaces; files map a
 * commit's tree onto them; derived artefacts are cached under workspace-keyed
 * HMAC derivation keys. Every table carries workspace_id for row-level
 * security. Secrets never reach `blobs.content`: they are replaced by typed
 * placeholders and recorded as HMAC fingerprints in `redactions`.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('repositories', (table) => {
      table.string('default_ref', 255).notNullable().defaultTo('main')
      table.uuid('active_commit_id').nullable()
      table.string('status', 32).notNullable().defaultTo('registered')
    })

    this.schema.createTable('commits', (table) => {
      table.uuid('id').primary()
      table.uuid('workspace_id').notNullable()
      table.uuid('repository_id').notNullable()
      table.string('sha', 64).notNullable()
      table.string('object_format', 16).notNullable().defaultTo('sha1')
      table.jsonb('parent_shas').notNullable().defaultTo('[]')
      table.timestamp('committed_at').nullable()
      table.string('status', 32).notNullable().defaultTo('resolving')
      table.timestamp('indexed_at').nullable()
      table.timestamp('created_at').notNullable()
      table.unique(['repository_id', 'sha'])
    })

    this.schema.createTable('refs', (table) => {
      table.uuid('workspace_id').notNullable()
      table.uuid('repository_id').notNullable()
      table.string('name', 255).notNullable()
      table.string('commit_sha', 64).notNullable()
      table.timestamp('updated_at').notNullable()
      table.primary(['repository_id', 'name'])
    })

    this.schema.createTable('blobs', (table) => {
      table.uuid('workspace_id').notNullable()
      table.string('blob_sha', 64).notNullable()
      table.string('content_sha256', 64).notNullable()
      table.integer('size').notNullable()
      table.text('content').nullable()
      table.string('skip_reason', 64).nullable()
      table.boolean('redacted').notNullable().defaultTo(false)
      table.timestamp('created_at').notNullable()
      table.primary(['workspace_id', 'blob_sha'])
    })

    this.schema.createTable('files', (table) => {
      table.uuid('workspace_id').notNullable()
      table.uuid('commit_id').notNullable()
      table.text('path').notNullable()
      table.string('blob_sha', 64).notNullable()
      table.string('mode', 6).notNullable()
      table.string('change', 16).notNullable()
      table.primary(['commit_id', 'path'])
    })

    this.schema.createTable('redactions', (table) => {
      table.uuid('workspace_id').notNullable()
      table.string('blob_sha', 64).notNullable()
      table.string('rule', 64).notNullable()
      table.string('fingerprint', 64).notNullable()
      table.integer('line').notNullable()
      table.primary(['workspace_id', 'blob_sha', 'rule', 'line'])
    })

    this.schema.createTable('ingest_steps', (table) => {
      table.uuid('workspace_id').notNullable()
      table.uuid('repository_id').notNullable()
      table.string('commit_sha', 64).notNullable()
      table.string('step', 32).notNullable()
      table.string('status', 16).notNullable()
      table.integer('actor_user_id').nullable()
      table.jsonb('result').notNullable().defaultTo('{}')
      table.timestamp('started_at').notNullable()
      table.timestamp('finished_at').nullable()
      table.primary(['repository_id', 'commit_sha', 'step'])
    })

    this.schema.createTable('derivation_cache', (table) => {
      table.uuid('workspace_id').notNullable()
      table.string('key', 64).notNullable()
      table.string('kind', 32).notNullable()
      table.jsonb('value').notNullable()
      table.timestamp('created_at').notNullable()
      table.primary(['workspace_id', 'key'])
    })

    // Inbox addresses for push webhooks: no tenant content, no RLS. A
    // delivery is routed by an unguessable handle and authenticated by the
    // per-repository secret before anything scoped is touched (SEC-32).
    this.schema.createTable('webhook_endpoints', (table) => {
      table.string('handle', 32).primary()
      table.uuid('workspace_id').notNullable()
      table.uuid('repository_id').notNullable()
      table.string('secret', 128).notNullable()
      table.integer('acts_as_user_id').notNullable()
      table.timestamp('created_at').notNullable()
    })

    this.schema.createTable('webhook_deliveries', (table) => {
      table.uuid('workspace_id').notNullable()
      table.uuid('repository_id').notNullable()
      table.string('delivery_id', 128).notNullable()
      table.string('outcome', 32).notNullable()
      table.timestamp('received_at').notNullable()
      table.primary(['repository_id', 'delivery_id'])
    })

    // Foreign keys are added NOT VALID: the tables are empty, and validation
    // would query the referenced tables under row-level security, which
    // refuses reads outside a scoped transaction. Future writes are enforced.
    this.schema.raw(`
        ALTER TABLE commits ADD CONSTRAINT commits_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;
        ALTER TABLE commits ADD CONSTRAINT commits_repository_id_fk FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE NOT VALID;
        ALTER TABLE refs ADD CONSTRAINT refs_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;
        ALTER TABLE refs ADD CONSTRAINT refs_repository_id_fk FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE NOT VALID;
        ALTER TABLE blobs ADD CONSTRAINT blobs_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;
        ALTER TABLE files ADD CONSTRAINT files_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;
        ALTER TABLE files ADD CONSTRAINT files_commit_id_fk FOREIGN KEY (commit_id) REFERENCES commits(id) ON DELETE CASCADE NOT VALID;
        ALTER TABLE redactions ADD CONSTRAINT redactions_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;
        ALTER TABLE ingest_steps ADD CONSTRAINT ingest_steps_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;
        ALTER TABLE ingest_steps ADD CONSTRAINT ingest_steps_repository_id_fk FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE NOT VALID;
        ALTER TABLE derivation_cache ADD CONSTRAINT derivation_cache_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;
        ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;
        ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_repository_id_fk FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE NOT VALID;
    `)

    for (const table of [
      'commits',
      'refs',
      'blobs',
      'files',
      'redactions',
      'ingest_steps',
      'derivation_cache',
      'webhook_deliveries',
    ]) {
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
    for (const table of [
      'webhook_deliveries',
      'derivation_cache',
      'ingest_steps',
      'redactions',
      'files',
      'blobs',
      'refs',
      'commits',
    ]) {
      this.schema.dropTable(table)
    }
    this.schema.alterTable('repositories', (table) => {
      table.dropColumn('status')
      table.dropColumn('active_commit_id')
      table.dropColumn('default_ref')
    })
  }
}
