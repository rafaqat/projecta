import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * One BM25 index per workspace (ADR-022).
 *
 * The shared `chunks_search_bm25` and `symbols_name_bm25` counted every workspace's documents into
 * the inverse document frequency each workspace was ranked by, so a neighbour's corpus changed a
 * tenant's own scores and order. Row-level security cannot reach that: it filters the rows a query
 * returns, while the counts live inside the index and are maintained by writers.
 *
 * The index is created by this function rather than by SQL assembled in the application. `CREATE
 * INDEX` takes no bind parameters and an index name is an identifier, so building that statement in
 * TypeScript would mean a workspace id reaching query text (SEC-31). Here `format('%I', ...)` quotes
 * the identifier and `%L` the literal, and the application calls it as an ordinary query with the id
 * bound. The names match `app/retrieval/lexical_index.ts`, which is what the retriever queries.
 *
 * This migration does NOT create the per-workspace indexes for workspaces that already exist: it
 * cannot. Migrations run as `app`, which has no BYPASSRLS, and `boot_guards` refuses to start with a
 * role that does, so enumerating every workspace is unavailable to the application by design. Such a
 * workspace has no corpus of its own until its next ingest, and its lexical query raises
 * `42704 undefined_object`, which `isLexicalIndexFault` treats as a fault: the query is answered from
 * the tsvector column, which holds no corpus statistics and so cannot leak.
 *
 * `honeytokens_search_bm25` is left shared on purpose: it is the cross-workspace sensor (SEC-30),
 * whose query reads `where not (workspace_id = :workspace)` in order to see a foreign token.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.raw(`
      create or replace function ensure_lexical_indexes(workspace uuid) returns void
      language plpgsql as $ensure$
      declare
        suffix text := replace(workspace::text, '-', '');
      begin
        execute format(
          'create index if not exists %I on chunks using bm25 (search_text) '
          'with (text_config = ''simple'') where workspace_id = %L',
          'chunks_search_bm25_' || suffix, workspace
        );
        execute format(
          'create index if not exists %I on symbols using bm25 (qualified_name) '
          'with (text_config = ''simple'') where workspace_id = %L',
          'symbols_name_bm25_' || suffix, workspace
        );
      end
      $ensure$
    `)

    this.schema.raw('drop index if exists chunks_search_bm25')
    this.schema.raw('drop index if exists symbols_name_bm25')
  }

  async down() {
    this.schema.raw(`
      create index if not exists chunks_search_bm25 on chunks using bm25 (search_text)
        with (text_config = 'simple')
    `)
    this.schema.raw(`
      create index if not exists symbols_name_bm25 on symbols using bm25 (qualified_name)
        with (text_config = 'simple')
    `)
    this.schema.raw('drop function if exists ensure_lexical_indexes(uuid)')
  }
}
