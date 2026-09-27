import { createHash } from 'node:crypto'
import type { DependencyFact } from '#app/dependencies/extractor'
import type { ManifestRecord } from '#app/dependencies/manifests'

/**
 * SPDX 2.3 export of the dependency table.
 *
 * Four rules decide what this document asserts, and all four exist because the commonest failure
 * of a bill of materials is looking more complete than it is:
 *
 * - It never states a version it did not read. A manifest declaring `^4.17.0` declares a range, and
 *   a scanner reading that as a version matches the wrong advisories. The range is reported as an
 *   annotation; `versionInfo` is `NOASSERTION`.
 * - It declares its own gaps. Manifests the index recognised and could not read are named in the
 *   document comment, so an empty result is distinguishable from an unparsed one.
 * - It says what it is: derived from the manifests committed at one commit, not from an installed
 *   tree, with `licenseConcluded` unasserted wherever nothing read a licence.
 * - It carries reachability. A package is annotated with the files that import it, and "no
 *   importers" is written as "no import found", never as "unused".
 */
export interface SpdxAnnotation {
  annotationType: 'OTHER'
  annotator: 'Tool: code-intelligence-assistant'
  annotationDate: string
  comment: string
}

export interface SpdxPackage {
  SPDXID: string
  name: string
  versionInfo: string
  downloadLocation: string
  filesAnalyzed: false
  licenseConcluded: string
  licenseDeclared: string
  copyrightText: string
  externalRefs?: Array<{
    referenceCategory: 'PACKAGE-MANAGER'
    referenceType: 'purl'
    referenceLocator: string
  }>
  checksums?: Array<{ algorithm: string; checksumValue: string }>
  annotations?: SpdxAnnotation[]
}

export interface SpdxDocument {
  spdxVersion: 'SPDX-2.3'
  dataLicense: 'CC0-1.0'
  SPDXID: 'SPDXRef-DOCUMENT'
  name: string
  documentNamespace: string
  creationInfo: { created: string; creators: string[]; comment: string }
  packages: SpdxPackage[]
  relationships: Array<{
    spdxElementId: string
    relationshipType: 'DESCRIBES'
    relatedSpdxElement: string
  }>
}

export interface SpdxMeta {
  /** The repository the table was read from. */
  name: string
  /** The commit the manifests were read at: what makes the document reproducible. */
  commit: string
  at: string
}

/** A version string that is a range or an unresolved reference rather than a resolved version. */
export function isRange(version: string): boolean {
  if (!version.trim()) return true
  return /[\^~*x]|\s-\s|[<>=]|\|\||,/.test(version)
}

const PURL_ECOSYSTEM: Record<string, string> = {
  npm: 'npm',
  pypi: 'pypi',
  cargo: 'cargo',
  go: 'golang',
  rubygems: 'gem',
  maven: 'maven',
  gradle: 'maven',
  swiftpm: 'swift',
}

/** `pkg:npm/%40scope/name@1.2.3`; omitted when the version is not one. */
function purl(fact: DependencyFact): string | null {
  const type = PURL_ECOSYSTEM[fact.ecosystem]
  if (!type || isRange(fact.version)) return null
  return `pkg:${type}/${fact.name.replace(/^@/, '%40')}@${fact.version}`
}

const LOCATOR_SCHEMES = new Set(['https:', 'http:', 'git+https:', 'git+ssh:', 'git+http:'])

/**
 * A download location from a lockfile's `resolved` (AC-WP21-03). The value is repository content,
 * so it is untrusted: only a URL with a fetchable scheme passes, and it passes without userinfo,
 * query or fragment — a private registry's `resolved` can carry a token, and an SBOM is a document
 * people forward. Anything else is `NOASSERTION`, which is what SPDX means by "not stated".
 */
export function locatorOf(resolved: string | null): string {
  if (!resolved) return 'NOASSERTION'
  let url: URL
  try {
    url = new URL(resolved)
  } catch {
    return 'NOASSERTION'
  }
  if (!LOCATOR_SCHEMES.has(url.protocol) || !url.hostname) return 'NOASSERTION'
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.toString()
}

const SRI_ALGORITHM: Record<string, string> = {
  sha1: 'SHA1',
  sha256: 'SHA256',
  sha384: 'SHA384',
  sha512: 'SHA512',
}

/**
 * A lockfile's integrity is Subresource Integrity (`sha512-<base64>`, space-separated when there
 * are several); SPDX 2.3 wants one checksum per algorithm, in lowercase hex. An algorithm SPDX does
 * not name, or a value that is not SRI, yields no checksum rather than a guessed one.
 */
export function checksumsOf(
  integrity: string | null
): Array<{ algorithm: string; checksumValue: string }> {
  if (!integrity) return []
  const out: Array<{ algorithm: string; checksumValue: string }> = []
  for (const token of integrity.trim().split(/\s+/)) {
    const match = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(token)
    if (!match) continue
    const hex = Buffer.from(match[2], 'base64').toString('hex')
    if (hex) out.push({ algorithm: SRI_ALGORITHM[match[1]], checksumValue: hex })
  }
  return out
}

/** Stable and readable: the identity is the ecosystem, name and version, digested for uniqueness. */
function idFor(fact: DependencyFact): string {
  const slug = `${fact.ecosystem}-${fact.name}`.replace(/[^A-Za-z0-9.-]/g, '-')
  const digest = createHash('sha256')
    .update(JSON.stringify([fact.ecosystem, fact.name, fact.version]))
    .digest('hex')
    .slice(0, 8)
  return `SPDXRef-Package-${slug}-${digest}`
}

function annotationsFor(fact: DependencyFact, at: string): SpdxAnnotation[] {
  const note = (comment: string): SpdxAnnotation => ({
    annotationType: 'OTHER',
    annotator: 'Tool: code-intelligence-assistant',
    annotationDate: at,
    comment,
  })
  const where = fact.line === null ? fact.manifest : `${fact.manifest} line ${fact.line}`
  const out = [note(`declared in ${where} as a ${fact.kind} dependency`)]
  if (isRange(fact.version)) {
    out.push(
      note(
        `declared range ${fact.version} — no lockfile pinned it at this commit, so no version is asserted`
      )
    )
  }
  // Reachability: the part a scanner cannot know. Absence is a finding, not a blank, and
  // it means the import extractor found nothing — never that the package is unused.
  out.push(
    fact.importers.length
      ? note(
          `imported by ${fact.importers.length} file(s): ${[...fact.importers].sort().join(', ')}`
        )
      : note(
          'no import found — the extractor saw no import of this package; not a claim that it is unused'
        )
  )
  return out
}

function namespaceFor(meta: SpdxMeta): string {
  const hex = createHash('sha256')
    .update(JSON.stringify([meta.name, meta.commit]))
    .digest('hex')
  const uuid = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
  return `urn:uuid:${uuid}`
}

export interface RootReading {
  /** Repo-relative directory of this root; `''` for the repository root. */
  prefix: string
  dependencies: DependencyFact[]
  manifests: ManifestRecord[]
}

/**
 * One document from several roots. A repository that ships sidecar services has a lockfile per
 * service, and Tier 0 reads only the root one — so the caller reads each root separately
 * and merges here. Paths are rewritten repo-relative so a row still cites a file that exists.
 *
 * Every distinct declaration survives: one package at one version can be a dev dependency of the
 * application and a runtime dependency of a service, and keeping only the first would say "dev
 * only" about something that ships. `renderSpdx` folds them into one package carrying both
 * declarations. Two versions of one package likewise stay two rows — collapsing them would pick a
 * winner the repository never picked, and "which of our services is on the old one" is the
 * question being asked.
 */
export function mergeRoots(roots: RootReading[]): {
  dependencies: DependencyFact[]
  manifests: ManifestRecord[]
} {
  const under = (prefix: string, path: string) => (prefix ? `${prefix}/${path}` : path)
  const dependencies: DependencyFact[] = []
  const manifests: ManifestRecord[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    for (const fact of root.dependencies) {
      const key = JSON.stringify([
        fact.ecosystem,
        fact.name,
        fact.version,
        under(root.prefix, fact.manifest),
        fact.kind,
      ])
      if (seen.has(key)) continue
      seen.add(key)
      dependencies.push({ ...fact, manifest: under(root.prefix, fact.manifest) })
    }
    for (const manifest of root.manifests) {
      manifests.push({ ...manifest, path: under(root.prefix, manifest.path) })
    }
  }
  return { dependencies, manifests }
}

export function renderSpdx(
  dependencies: DependencyFact[],
  manifests: ManifestRecord[],
  meta: SpdxMeta
): SpdxDocument {
  const unread = manifests.filter((m) => m.status === 'unread')
  const read = manifests.filter((m) => m.status === 'read')
  const ranged = dependencies.filter((d) => isRange(d.version)).length
  const comment = [
    `Derived from the manifests committed at ${meta.commit}, not from an installed dependency tree;`,
    'the two differ wherever a manifest is not the whole story. Nothing was fetched to build it.',
    `${read.length} manifest(s) read, ${unread.length} recognised and unread${
      unread.length ? `: ${unread.map((m) => m.path).join(', ')}` : ''
    }.`,
    `${ranged} package(s) are declared as a range and carry no asserted version.`,
    'licenseConcluded is NOASSERTION wherever no licence was read; it is not a claim of no licence.',
  ].join(' ')

  const packages: SpdxPackage[] = []
  const relationships: SpdxDocument['relationships'] = []
  const seen = new Set<string>()
  const ordered = [...dependencies].sort(
    (a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name)
  )
  const byId = new Map<string, SpdxPackage>()
  for (const fact of ordered) {
    const id = idFor(fact)
    const already = byId.get(id)
    if (already) {
      // The same package at the same version, declared somewhere else too. One package, every
      // declaration: dropping the second is how a shipped dependency comes to read as dev-only.
      const known = new Set(already.annotations?.map((a) => a.comment))
      for (const note of annotationsFor(fact, meta.at)) {
        if (!known.has(note.comment)) already.annotations!.push(note)
      }
      continue
    }
    seen.add(id)
    const locator = purl(fact)
    const entry: SpdxPackage = {
      SPDXID: id,
      name: fact.name,
      versionInfo: isRange(fact.version) ? 'NOASSERTION' : fact.version,
      downloadLocation: locatorOf(fact.resolved),
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      ...(locator
        ? {
            externalRefs: [
              {
                referenceCategory: 'PACKAGE-MANAGER' as const,
                referenceType: 'purl' as const,
                referenceLocator: locator,
              },
            ],
          }
        : {}),
      ...(checksumsOf(fact.integrity).length ? { checksums: checksumsOf(fact.integrity) } : {}),
      annotations: annotationsFor(fact, meta.at),
    }
    byId.set(id, entry)
    packages.push(entry)
    relationships.push({
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: id,
    })
  }

  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${meta.name}@${meta.commit.slice(0, 12)}`,
    documentNamespace: namespaceFor(meta),
    creationInfo: {
      created: meta.at,
      creators: ['Tool: code-intelligence-assistant'],
      comment,
    },
    packages,
    relationships,
  }
}
