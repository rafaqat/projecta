import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The trace id of a turn's request: so the Traces page can read the turn's runtime
 * spans from the telemetry backend. Forward-only; turns before this have none.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('turns', (table) => {
      table.string('trace_id', 32).nullable()
    })
  }

  async down() {
    this.schema.alterTable('turns', (table) => {
      table.dropColumn('trace_id')
    })
  }
}
