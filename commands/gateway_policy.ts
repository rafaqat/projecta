import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import canonicalize from 'canonicalize'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * `node ace gateway:policy` writes the gateway policy for the current
 * configuration: validated configHash, prompt and tool hashes, models,
 * canaries, routes and the attribution public keys. Signing locally uses
 * GATEWAY_POLICY_SEED; in production the protected release workflow signs
 * (WP-14) and this command only prints what it would publish.
 */
export default class GatewayPolicy extends BaseCommand {
  static commandName = 'gateway:policy'
  static description =
    'Write config/gateway-policy.json (and its signature when a local seed is set)'
  static options: CommandOptions = { startApp: true }

  @flags.string({ description: 'Output path', default: 'config/gateway-policy.json' })
  declare out: string

  @flags.boolean({
    description:
      'Verify the on-disk policy matches this APP_KEY and config; write nothing, exit non-zero on drift',
    default: false,
  })
  declare check: boolean

  async run() {
    const { configHash, otherEvidenceHash } = await import('#app/audit/config_hash')
    const { publicJwk, attributionKid } = await import('#app/security/attribution')
    const { PROMPTS } = await import('#app/assistant/prompts/index')
    const { MODELS } = await import('#app/llm/client')
    const { CLASSIFIER_SYSTEM, CLASSIFIER_TOOL } = await import('#app/retrieval/scope_classifier')
    const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
    const { hash, manifest } = configHash()
    const policy = {
      version: 1,
      issuedAt: new Date().toISOString(),
      models: [MODELS.answer, MODELS.scopeClassifier],
      // Both evidence paths: the comparison runs each against this policy.
      configHashes: [hash, otherEvidenceHash()],
      promptHashes: [PROMPTS.system.sha256, sha256(CLASSIFIER_SYSTEM)],
      toolDefinitionHashes: [
        sha256(canonicalize(manifest.tools)!),
        sha256(
          canonicalize([{ name: CLASSIFIER_TOOL.name, inputSchema: CLASSIFIER_TOOL.input_schema }])!
        ),
      ],
      blockTypes: ['text', 'search_result', 'tool_use', 'tool_result'],
      canaries: [process.env.SYSTEM_PROMPT_CANARY ?? ''].filter(Boolean),
      // ADR-0007: external URLs are never shown — the URL rule masks every non-identifier host,
      // so the allowlist is empty (identifier/origin hosts stay exempt inside the rule itself).
      allowedUrlHosts: [],
      routes: { default: 'anthropic', workspaces: {} },
      attributionKeys: {
        [attributionKid('web')]: await publicJwk('web'),
        [attributionKid('worker')]: await publicJwk('worker'),
      },
    }
    // Deploy tripwire: the attributionKeys are derived from APP_KEY and the configHashes from the
    // prompts/profiles/scope-policy. If the running gateway loads a policy that no longer matches
    // (a committed placeholder, or one signed for a different APP_KEY), it rejects EVERY model call
    // with attribution_invalid — silently, until someone asks a question. `--check` catches that at
    // deploy time so the fix (`make policy` + reload the gateway) happens with the code, not later.
    if (this.check) {
      const { readFile } = await import('node:fs/promises')
      let onDisk: { attributionKeys?: unknown; configHashes?: string[] }
      try {
        onDisk = JSON.parse(await readFile(this.out, 'utf8'))
      } catch {
        this.logger.error(`no policy at ${this.out} — run \`make policy\``)
        this.exitCode = 1
        return
      }
      const keysMatch =
        canonicalize(onDisk.attributionKeys ?? {}) === canonicalize(policy.attributionKeys)
      const configOk = policy.configHashes.every((h) => (onDisk.configHashes ?? []).includes(h))
      if (keysMatch && configOk) {
        this.logger.success('gateway policy matches this APP_KEY and config')
        return
      }
      if (!keysMatch)
        this.logger.error(
          'attributionKeys do NOT match this APP_KEY: the gateway will 401 every model call (attribution_invalid). Run `make policy` and reload the gateway.'
        )
      if (!configOk)
        this.logger.error(
          'configHashes do NOT cover the current config: the gateway will reject with config_hash_unvalidated. Run `make policy`.'
        )
      this.exitCode = 1
      return
    }
    await mkdir('config', { recursive: true })
    await writeFile(this.out, JSON.stringify(policy, null, 2) + '\n')
    const seed = process.env.GATEWAY_POLICY_SEED
    if (seed) {
      const key = createPrivateKey({
        key: Buffer.concat([
          Buffer.from('302e020100300506032b657004220420', 'hex'),
          Buffer.from(seed, 'hex'),
        ]),
        format: 'der',
        type: 'pkcs8',
      })
      const digest = createHash('sha256').update(canonicalize(policy)!).digest()
      await writeFile(`${this.out}.sig`, sign(null, digest, key).toString('base64url') + '\n')
      this.logger.success(
        `signed ${this.out}; public key: ${JSON.stringify(createPublicKey(key).export({ format: 'jwk' }))}`
      )
    } else {
      this.logger.info(`wrote ${this.out} unsigned; the release workflow signs it (WP-14)`)
    }
  }
}
