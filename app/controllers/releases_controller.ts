import type { HttpContext } from '@adonisjs/core/http'
import { configHash, validatedRunFor } from '#app/audit/config_hash'
import WorkspaceTransformer from '#transformers/workspace_transformer'
import { assetsVersion } from '#app/assets_version'

/**
 * The Releases / Configuration page: the signed configuration that shapes every answer —
 * the config hash, whether an eval run validated it, the models, prompt versions, embedder, chunker
 * and evidence mode. Read-only. There is no releases history yet (gap); this is the live
 * configuration, workspace-scoped for navigation.
 */
export default class ReleasesController {
  async index({ scope, inertia }: HttpContext) {
    const { manifest, hash } = configHash()
    const validatedByRun = validatedRunFor(hash)
    return inertia.render('releases/index', {
      workspace: WorkspaceTransformer.transform(scope.workspace),
      configHash: hash,
      validatedByRun,
      prompts: Object.entries(manifest.prompts).map(([id, p]) => ({
        id,
        version: p.version,
        sha256: p.sha256,
      })),
      models: manifest.models,
      embedder: manifest.embedder,
      chunker: manifest.chunker,
      evidence: manifest.runtime.evidence,
      lexicalBackend: manifest.runtime.lexicalBackend,
      detectors: manifest.detectors,
      tools: manifest.tools.map((t) => t.name),
      assetsVersion: assetsVersion(),
    } as never)
  }
}
