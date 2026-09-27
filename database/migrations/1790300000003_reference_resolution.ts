import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Resolution tiers on references: `exact` follows a declaration,
 * type, constructor or import; `alias` an import the link pass resolved
 * through a path alias; `heuristic` a member matched by name alone;
 * `external` a package; `unresolved` a call the index could not place —
 * kept by name (`target_name`) and counted, never taken for absence.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('symbol_references', (table) => {
      table.string('resolution', 16).notNullable().defaultTo('exact')
      table.string('target_name', 512).nullable()
      table.index(['commit_id', 'resolution'])
    })
  }

  async down() {
    this.schema.alterTable('symbol_references', (table) => {
      table.dropIndex(['commit_id', 'resolution'])
      table.dropColumn('target_name')
      table.dropColumn('resolution')
    })
  }
}
