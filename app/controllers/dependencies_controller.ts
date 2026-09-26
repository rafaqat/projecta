import type { HttpContext } from '@adonisjs/core/http'
import { inScope } from '#app/security/scope'
import { isHandle } from '#app/security/handles'
import { exportSource, renderExport, turnInRepository } from '#app/dependencies/export_source'

/**
 * The dependency table of one turn's commit as SPDX 2.3 (WP-21) or CycloneDX 1.6
 * (WP-22), downloaded under the reader's session.
 *
 * The export is keyed by the turn whose card it is downloaded from, and renders the commit that
 * turn was grounded at — not the repository's active commit, which may have moved since and would
 * hand back a different table from the one on screen. A turn handle rather than the commit SHA
 * because no route takes a bare SHA (INV-10). The lookup lives in `export_source`, shared with the
 * public share-link route (WP-23), so scoping and erasure hold for every way out.
 */
export default class DependenciesController {
  spdx(ctx: HttpContext) {
    return this.download(ctx, 'spdx')
  }

  cyclonedx(ctx: HttpContext) {
    return this.download(ctx, 'cyclonedx')
  }

  private async download(
    { auth, scope, params, response }: HttpContext,
    format: 'spdx' | 'cyclonedx'
  ) {
    if (!isHandle(params.turn)) return response.notFound({ error: 'no such turn here' })
    const repository = scope.repository!
    const tenant = { userId: auth.getUserOrFail().id, workspaceId: scope.workspace.id }
    const source = await inScope(tenant, async (trx) => {
      const turn = await turnInRepository(trx, repository.id, params.turn)
      return turn ? exportSource(trx, repository.id, turn.commitId) : null
    })
    if (!source) return response.notFound({ error: 'no such turn here' })
    const { body, mediaType, file } = renderExport(format, source, repository.name)
    response.header('content-type', `${mediaType}; charset=utf-8`)
    response.header('content-disposition', `attachment; filename="${file}"`)
    return response.send(body)
  }
}
