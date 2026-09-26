import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 *: a chunk records the scan version that produced its `injection_suspected`, so a bump of
 * SCAN_VERSION makes an index stale the way a chunker bump does. Nullable: rows from before this
 * migration have no known scan version, which reads as stale. Forward-only (R-12).
 */
export default class extends BaseSchema {
  protected tableName = 'chunks'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('scan_version', 32).nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('scan_version')
    })
  }
}
