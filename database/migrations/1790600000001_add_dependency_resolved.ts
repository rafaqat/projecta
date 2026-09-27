import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Where each locked package was resolved from (WP-21, AC-WP21-01): so an SPDX export from the
 * index carries the same download locations `deps:sbom` reads from a checkout. The raw lockfile
 * value is stored; `renderSpdx` decides what of it may leave (AC-WP21-03), so tightening that rule
 * later needs no re-ingest. Forward-only; commits indexed before this have none and export
 * `NOASSERTION`, which is what the document says for an unknown location anyway.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('dependencies', (table) => {
      table.text('resolved').nullable()
    })
  }

  async down() {
    this.schema.alterTable('dependencies', (table) => {
      table.dropColumn('resolved')
    })
  }
}
