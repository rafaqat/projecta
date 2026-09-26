import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 *: a flagged chunk records which 2,000-character window of its prose the detector
 * labelled, so the repository page can show a reader what the classifier read. Nullable: unflagged
 * chunks, and chunks scanned before this migration, record nothing. Forward-only (R-12).
 */
export default class extends BaseSchema {
  protected tableName = 'chunks'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.smallint('flagged_window').nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('flagged_window')
    })
  }
}
