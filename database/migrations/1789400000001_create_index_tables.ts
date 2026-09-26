import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Index tables. Symbols anchor, citation blocks
 * cite, chunks retrieve. Chunk rows are per commit and carry both the
 * pg_textsearch BM25 view (`search_text`) and the tsvector fallback
 * (`search_tsv`) so LEXICAL_BACKEND can switch without re-indexing.
 * `honeytokens` is deliberately global (no RLS): it is the tripwire whose
 * foreign rows must surface if the application's workspace filter ever
 * fails (SEC-30). Foreign keys are NOT VALID for the same reason as the
 * ingestion migration.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('symbols', (table) => {
      table.uuid('id').primary()
      table.uuid('workspace_id').notNullable()
      table.uuid('commit_id').notNullable()
      table.text('path').notNullable()
      table.string('blob_sha', 64).notNullable()
      table.string('kind', 16).notNullable()
      table.string('name', 512).notNullable()
      table.text('qualified_name').notNullable()
      table.text('parent').nullable()
      table.integer('start_line').notNullable()
      table.integer('end_line').notNullable()
      table.string('language', 16).notNullable()
      table.index(['commit_id', 'path'])
    })

    this.schema.createTable('citation_blocks', (table) => {
      table.uuid('id').primary()
      table.uuid('workspace_id').notNullable()
      table.uuid('symbol_id').notNullable()
      table.integer('ordinal').notNullable()
      table.integer('start_line').notNullable()
      table.integer('end_line').notNullable()
      table.unique(['symbol_id', 'ordinal'])
    })

    this.schema.createTable('chunks', (table) => {
      table.uuid('id').primary()
      table.uuid('workspace_id').notNullable()
      table.uuid('commit_id').notNullable()
      table.text('path').notNullable()
      table.string('blob_sha', 64).notNullable()
      table.uuid('symbol_id').nullable()
      table.integer('start_line').notNullable()
      table.integer('end_line').notNullable()
      table.text('text').notNullable()
      table.text('search_text').notNullable()
      table.string('embedding_key', 64).nullable()
      table.string('chunker_version', 32).notNullable()
      table.boolean('injection_suspected').notNullable().defaultTo(false)
      table.index(['commit_id'])
    })
    this.schema.raw(`
      ALTER TABLE chunks ADD COLUMN embedding halfvec(768);
      ALTER TABLE chunks ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED;
      CREATE INDEX chunks_search_bm25 ON chunks USING bm25 (search_text) WITH (text_config = 'simple');
      CREATE INDEX chunks_search_tsv ON chunks USING gin (search_tsv);
      CREATE INDEX symbols_name_bm25 ON symbols USING bm25 (qualified_name) WITH (text_config = 'simple');
    `)

    this.schema.createTable('repo_facts', (table) => {
      table.uuid('commit_id').primary()
      table.uuid('workspace_id').notNullable()
      table.string('profile', 16).notNullable()
      table.jsonb('facts').notNullable()
    })

    this.schema.createTable('honeytokens', (table) => {
      table.uuid('id').primary()
      table.uuid('workspace_id').notNullable().unique()
      table.string('token', 64).notNullable().unique()
      table.text('text').notNullable()
      table.text('search_text').notNullable()
      table.timestamp('created_at').notNullable()
    })
    this.schema.raw(`
      ALTER TABLE honeytokens ADD COLUMN embedding halfvec(768);
      ALTER TABLE honeytokens ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED;
      CREATE INDEX honeytokens_search_bm25 ON honeytokens USING bm25 (search_text) WITH (text_config = 'simple');
    `)

    this.schema.raw(`
      ALTER TABLE symbols ADD CONSTRAINT symbols_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;
      ALTER TABLE symbols ADD CONSTRAINT symbols_commit_id_fk FOREIGN KEY (commit_id) REFERENCES commits(id) ON DELETE CASCADE NOT VALID;
      ALTER TABLE citation_blocks ADD CONSTRAINT citation_blocks_symbol_id_fk FOREIGN KEY (symbol_id) REFERENCES symbols(id) ON DELETE CASCADE NOT VALID;
      ALTER TABLE chunks ADD CONSTRAINT chunks_commit_id_fk FOREIGN KEY (commit_id) REFERENCES commits(id) ON DELETE CASCADE NOT VALID;
      ALTER TABLE chunks ADD CONSTRAINT chunks_symbol_id_fk FOREIGN KEY (symbol_id) REFERENCES symbols(id) ON DELETE SET NULL NOT VALID;
      ALTER TABLE repo_facts ADD CONSTRAINT repo_facts_commit_id_fk FOREIGN KEY (commit_id) REFERENCES commits(id) ON DELETE CASCADE NOT VALID;
    `)

    for (const table of ['symbols', 'citation_blocks', 'chunks', 'repo_facts']) {
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
    for (const table of ['honeytokens', 'repo_facts', 'chunks', 'citation_blocks', 'symbols']) {
      this.schema.dropTable(table)
    }
  }
}
