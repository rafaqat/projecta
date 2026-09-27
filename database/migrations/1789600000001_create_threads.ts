import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Threads and turns (design §6). Conversation state is per
 * thread and holds answer text plus citation handles, never tool results.
 * Withheld model text is kept with released=false so a false withholding can
 * be reviewed; it is thread content, under thread retention, not audit.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('threads', (table) => {
      table.uuid('id').primary()
      table.string('handle', 16).notNullable().unique()
      table.uuid('workspace_id').notNullable()
      table.uuid('repository_id').notNullable()
      table.integer('user_id').notNullable()
      table.timestamp('created_at').notNullable()
    })
    this.schema.createTable('turns', (table) => {
      table.uuid('id').primary()
      table.uuid('thread_id').notNullable()
      table.uuid('workspace_id').notNullable()
      table.string('run_handle', 16).notNullable()
      table.uuid('commit_id').notNullable()
      table.text('question').notNullable()
      table.text('answer_text').notNullable().defaultTo('')
      table.text('withheld_text').notNullable().defaultTo('')
      table.boolean('released').notNullable().defaultTo(true)
      table.jsonb('citation_handles').notNullable().defaultTo('[]')
      table.string('run_state', 16).notNullable()
      table.string('scope_label', 16).nullable()
      table.boolean('strict_regenerated').notNullable().defaultTo(false)
      table.timestamp('created_at').notNullable()
      table.index(['thread_id', 'created_at'])
    })
    this.schema.raw(`
      ALTER TABLE threads ADD CONSTRAINT threads_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;
      ALTER TABLE threads ADD CONSTRAINT threads_repository_id_fk FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE NOT VALID;
      ALTER TABLE turns ADD CONSTRAINT turns_thread_id_fk FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE NOT VALID;
    `)
    for (const table of ['threads', 'turns']) {
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
    this.schema.dropTable('turns')
    this.schema.dropTable('threads')
  }
}
