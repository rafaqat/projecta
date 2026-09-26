import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import { WorkspaceMembershipSchema } from '#database/schema'
import User from '#models/user'

export default class WorkspaceMembership extends WorkspaceMembershipSchema {
  @belongsTo(() => User)
  declare user: BelongsTo<typeof User>
}
