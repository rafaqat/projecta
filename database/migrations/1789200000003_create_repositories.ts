import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Repository ACLs (SEC-05): `workspace` visibility grants every
 * member; `restricted` grants only explicit repository members.
 * `repository_members.workspace_id` is denormalised so its RLS policy needs
 * no join, which keeps the policy graph acyclic.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('repositories', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table.uuid('workspace_id').notNullable().references('workspaces.id').onDelete('CASCADE')
      table.string('handle', 32).notNullable().unique()
      table.string('name', 200).notNullable()
      table.string('url', 2048).notNullable()
      table.enum('visibility', ['workspace', 'restricted']).notNullable().defaultTo('workspace')
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
    })

    this.schema.createTable('repository_members', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table.uuid('workspace_id').notNullable().references('workspaces.id').onDelete('CASCADE')
      table.uuid('repository_id').notNullable().references('repositories.id').onDelete('CASCADE')
      table.integer('user_id').notNullable().references('users.id').onDelete('CASCADE')
      table.timestamp('created_at').notNullable()
      table.unique(['repository_id', 'user_id'])
    })
  }

  async down() {
    this.schema.dropTable('repository_members')
    this.schema.dropTable('repositories')
  }
}
