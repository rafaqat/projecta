import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { extractTar, type TarRejection } from '#app/dependencies/tar'

/**
 * Tier 1 lockfile-safe fetch (SEC-04). A package is fetched by
 * `name@version` from the configured registries only; the lockfile's
 * `resolved` URL is carried for the record and never followed. The
 * download is capped, its integrity verified against the lockfile hash
 * before decompression, and extraction keeps only `package.json` and
 * `.d.ts` files. Dependency text is untrusted input like repository text.
 */
export interface PackagePin {
  name: string
  version: string
  integrity: string | null
  resolved: string | null
}

export type Tier1Rejection =
  | 'invalid_name_or_version'
  | 'no_registry_configured'
  | 'no_integrity'
  | 'unsupported_integrity'
  | 'not_found'
  | 'download_failed'
  | 'download_too_large'
  | 'integrity_mismatch'
  | TarRejection

export type Tier1Result =
  | { status: 'ok'; registry: string; files: Map<string, string> }
  | { status: 'rejected'; reason: Tier1Rejection }

export interface RegistryConfig {
  registries: string[]
  caFile: string | null
  maxTarballBytes: number
  timeoutMs: number
}

export function registryConfig(env: NodeJS.ProcessEnv = process.env): RegistryConfig {
  return {
    registries: (env.DEPENDENCY_REGISTRIES ?? '')
      .split(',')
      .map((r) => r.trim().replace(/\/+$/, ''))
      .filter((r) => r.startsWith('https://')),
    caFile: env.DEPENDENCY_REGISTRY_CA ?? null,
    maxTarballBytes: Number(env.DEPENDENCY_MAX_TARBALL_BYTES ?? 16 * 1024 * 1024),
    timeoutMs: Number(env.DEPENDENCY_FETCH_TIMEOUT_MS ?? 20_000),
  }
}

// npm naming rules; lowercase only, no path or query characters (SEC-04 embedded parameters).
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]{0,99}\/)?[a-z0-9][a-z0-9._-]{0,213}$/
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const INTEGRITY = /^(sha512|sha256|sha1)-([A-Za-z0-9+/=]+)$/
const KEEP = (path: string) => path === 'package.json' || path.endsWith('.d.ts')

export function isValidPin(name: string, version: string): boolean {
  return PACKAGE_NAME.test(name) && VERSION.test(version) && !name.includes('..')
}

export function tarballUrl(registry: string, name: string, version: string): string {
  const basename = name.split('/').pop()!
  return `${registry}/${name}/-/${basename}-${version}.tgz`
}

function download(
  url: string,
  config: RegistryConfig
): Promise<{ status: number; bytes: Buffer | null }> {
  return new Promise((resolve) => {
    const ca = config.caFile ? readFileSync(config.caFile) : undefined
    const req = httpsRequest(url, { method: 'GET', ca, timeout: config.timeoutMs }, (res) => {
      const chunks: Buffer[] = []
      let received = 0
      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > config.maxTarballBytes) {
          res.destroy()
          resolve({ status: 413, bytes: null })
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, bytes: Buffer.concat(chunks) }))
      res.on('error', () => resolve({ status: 0, bytes: null }))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve({ status: 0, bytes: null }))
    req.end()
  })
}

export async function fetchPackageSurface(
  pin: PackagePin,
  config: RegistryConfig = registryConfig()
): Promise<Tier1Result> {
  if (!isValidPin(pin.name, pin.version))
    return { status: 'rejected', reason: 'invalid_name_or_version' }
  if (config.registries.length === 0)
    return { status: 'rejected', reason: 'no_registry_configured' }
  if (!pin.integrity) return { status: 'rejected', reason: 'no_integrity' }
  const integrity = INTEGRITY.exec(pin.integrity)
  if (!integrity) return { status: 'rejected', reason: 'unsupported_integrity' }

  let last: Tier1Rejection = 'not_found'
  for (const registry of config.registries) {
    const { status, bytes } = await download(tarballUrl(registry, pin.name, pin.version), config)
    if (status === 404) continue
    if (status === 413) return { status: 'rejected', reason: 'download_too_large' }
    if (status !== 200 || !bytes) {
      last = 'download_failed'
      continue
    }
    const digest = createHash(integrity[1]).update(bytes).digest('base64')
    if (digest !== integrity[2]) return { status: 'rejected', reason: 'integrity_mismatch' }
    const extracted = extractTar(bytes, KEEP)
    if (!extracted.ok) return { status: 'rejected', reason: extracted.reason }
    return { status: 'ok', registry, files: extracted.files }
  }
  return { status: 'rejected', reason: last }
}
