import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Where a running step is (`{phase, done, total}`), written while it runs
 * and read by the repository page. Separate from `result`, which is written
 * once at the end and read back on resume.
 */
export default class extends BaseSchema {
  protected tableName = 'ingest_steps'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.jsonb('progress').nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('progress')
    })
  }
}
