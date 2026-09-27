import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Why the last ingestion failed, written by the worker when a job fails
 * (UAT 2026-09-14: a fetch of a missing ref left the repository "registered"
 * with the reason visible only in the job table). Cleared when a run starts.
 */
export default class extends BaseSchema {
  protected tableName = 'repositories'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.text('status_detail').nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('status_detail')
    })
  }
}
