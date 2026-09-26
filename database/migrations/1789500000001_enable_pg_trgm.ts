import { BaseSchema } from '@adonisjs/lucid/schema'

/** Trigram similarity for the entity pre-check's "closest symbols" suggestions (design §5). */
export default class extends BaseSchema {
  async up() {
    this.schema.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm')
    this.schema.raw('CREATE INDEX symbols_name_trgm ON symbols USING gin (name gin_trgm_ops)')
  }

  async down() {
    this.schema.raw('DROP INDEX IF EXISTS symbols_name_trgm')
  }
}
