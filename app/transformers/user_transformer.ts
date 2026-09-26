import type User from '#models/user'
import { BaseTransformer } from '@adonisjs/core/transformers'

/**
 * Field allowlist for the shared `user` prop (SEC-21). No database ID, no
 * identity keys, no timestamps: pages need a name to greet and an email to
 * confirm who is signed in.
 */
export default class UserTransformer extends BaseTransformer<User> {
  toObject() {
    return this.pick(this.resource, ['fullName', 'email', 'initials'])
  }
}
