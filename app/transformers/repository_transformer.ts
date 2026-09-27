import type Repository from '#models/repository'
import { BaseTransformer } from '@adonisjs/core/transformers'

export default class RepositoryTransformer extends BaseTransformer<Repository> {
  toObject() {
    return this.pick(this.resource, ['handle', 'name', 'url', 'visibility'])
  }
}
