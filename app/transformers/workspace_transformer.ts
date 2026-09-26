import type Workspace from '#models/workspace'
import { BaseTransformer } from '@adonisjs/core/transformers'

/** Workspaces are addressed by handle in URLs; the UUID never leaves the server. */
export default class WorkspaceTransformer extends BaseTransformer<Workspace> {
  toObject() {
    return this.pick(this.resource, ['handle', 'name'])
  }
}
