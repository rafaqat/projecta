import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.createTable('workspaces', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table.string('handle', 32).notNullable().unique()
      table.string('name', 200).notNullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
    })

    this.schema.createTable('workspace_memberships', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table.uuid('workspace_id').notNullable().references('workspaces.id').onDelete('CASCADE')
      table.integer('user_id').notNullable().references('users.id').onDelete('CASCADE')
      table.enum('role', ['owner', 'member']).notNullable().defaultTo('member')
      table.timestamp('created_at').notNullable()
      table.unique(['workspace_id', 'user_id'])
    })
  }

  async down() {
    this.schema.dropTable('workspace_memberships')
    this.schema.dropTable('workspaces')
  }
}
