import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The audit chain's verdicts over time (WP-26): written by `audit:verify` as the
 * audit_writer role, read by the web role for "About this deployment". The web role cannot write
 * a verdict — a page that could record its own "verified" would prove nothing — and cannot verify
 * either, because that needs the signing key it never holds (AC-WP26-04). No tenant data, so no
 * workspace column and no row-level security. Forward-only.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('audit_verifications', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table.timestamp('verified_at').notNullable().defaultTo(this.raw('clock_timestamp()'))
      table.boolean('ok').notNullable()
      table.string('key_id', 64).notNullable()
      table.index(['verified_at'])
    })
    this.schema.raw(`
      REVOKE INSERT, UPDATE, DELETE ON audit_verifications FROM app;
      GRANT SELECT ON audit_verifications TO app;
      GRANT SELECT, INSERT ON audit_verifications TO audit_writer;
    `)
  }

  async down() {
    this.schema.dropTable('audit_verifications')
  }
}
