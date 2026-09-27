import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Ignore rules (UAT 2026-09-14): `repositories.ignore_paths` is the
 * workspace's list for the repository (null: the defaults in
 * app/ingest/ignore.ts); `files.ignored_by` names the pattern that kept a
 * file of the commit from being read, so the absence notice and the
 * indexing view can say so.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('repositories', (table) => {
      table.jsonb('ignore_paths').nullable()
    })
    this.schema.alterTable('files', (table) => {
      table.text('ignored_by').nullable()
    })
  }

  async down() {
    this.schema.alterTable('files', (table) => {
      table.dropColumn('ignored_by')
    })
    this.schema.alterTable('repositories', (table) => {
      table.dropColumn('ignore_paths')
    })
  }
}
