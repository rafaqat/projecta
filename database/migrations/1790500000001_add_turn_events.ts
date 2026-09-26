import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The released event stream of a turn (text, citations, verifications, views, notices — never
 * withheld text), so a thread reloaded from history renders exactly as it streamed: chips, marks
 * and index views included (UAT 2026-09-17: a reload after a deploy lost the callers card).
 * Thread content under the same retention and erasure as answer_text.
 */
export default class extends BaseSchema {
  protected tableName = 'turns'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.jsonb('events').nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('events')
    })
  }
}
