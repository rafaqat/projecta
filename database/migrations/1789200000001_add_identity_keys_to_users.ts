import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Users are identified by (tid, oid) from the identity provider and never
 * linked by email. Password stays only for local development login.
 */
export default class extends BaseSchema {
  protected tableName = 'users'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('tid', 128).nullable()
      table.string('oid', 128).nullable()
      table.string('password').nullable().alter()
      table.unique(['tid', 'oid'])
      // Email is contact data, not an identity key: two identities may share one.
      table.dropUnique(['email'])
      table.index(['email'])
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropIndex(['email'])
      table.unique(['email'])
      table.dropUnique(['tid', 'oid'])
      table.dropColumn('tid')
      table.dropColumn('oid')
    })
  }
}
