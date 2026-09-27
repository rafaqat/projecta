import { createHash } from 'node:crypto'
import type { DependencyFact } from '#app/dependencies/extractor'
import type { ManifestRecord } from '#app/dependencies/manifests'
import { checksumsOf, isRange, locatorOf, type SpdxMeta } from '#app/dependencies/spdx'

/**
 * CycloneDX 1.6 export of the dependency table, beside `renderSpdx` and over the same
 * facts, so the two formats cannot disagree about which packages exist.'s four rules hold,
 * and where SPDX had to say them in free text CycloneDX has fields:
 *
 * - never a version it did not read: a ranged package has no `version` and no `purl` (the schema
 *   requires neither), and its declared range is a property;
 * - its own gaps: `compositions[].aggregate` is `complete` only when no manifest went unread and no
 *   package is ranged, and unread manifests are named in `metadata.properties`;
 * - what it is: lifecycle `pre-build`, from committed manifests rather than an installed tree;
 * - reachability: importing files as `evidence.occurrences`. The index records which files import
 *   a package, not the line of the import, so an occurrence carries its location only.
 *
 * Scope is asserted only where a declaration supports it: `required` for a package any manifest
 * declares as a runtime dependency; nothing for dev-only or transitive-only packages. `excluded`
 * would claim runtime absence, which the index never observes.
 */
export interface CdxComponent {
  'type': 'library'
  'bom-ref': string
  'group'?: string
  'name': string
  'version'?: string
  'purl'?: string
  'scope'?: 'required'
  'hashes'?: Array<{ alg: string; content: string }>
  'externalReferences'?: Array<{ type: 'distribution'; url: string }>
  'evidence'?: { occurrences: Array<{ location: string }> }
  'properties'?: Array<{ name: string; value: string }>
}

export interface CdxDocument {
  bomFormat: 'CycloneDX'
  specVersion: '1.6'
  serialNumber: string
  version: 1
  metadata: {
    timestamp: string
    lifecycles: Array<{ phase: 'pre-build' }>
    tools: { components: Array<{ type: 'application'; name: string }> }
    component: { 'type': 'application'; 'bom-ref': string; 'name': string; 'version': string }
    properties: Array<{ name: string; value: string }>
  }
  components: CdxComponent[]
  compositions: Array<{ aggregate: 'complete' | 'incomplete' }>
}

const ALG: Record<string, string> = {
  SHA1: 'SHA-1',
  SHA256: 'SHA-256',
  SHA384: 'SHA-384',
  SHA512: 'SHA-512',
}

const PURL_TYPE: Record<string, string> = {
  npm: 'npm',
  pypi: 'pypi',
  cargo: 'cargo',
  go: 'golang',
  rubygems: 'gem',
  maven: 'maven',
  gradle: 'maven',
  swiftpm: 'swift',
}

/** A UUID derived from the repository and commit, with the version and variant bits CycloneDX requires. */
function serialFor(meta: SpdxMeta): string {
  const hex = createHash('sha256')
    .update(JSON.stringify(['cyclonedx', meta.name, meta.commit]))
    .digest('hex')
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** npm's `@scope/name` is CycloneDX's group and name. */
function groupAndName(fact: DependencyFact): { group?: string; name: string } {
  if (fact.ecosystem !== 'npm' || !fact.name.startsWith('@') || !fact.name.includes('/'))
    return { name: fact.name }
  const slash = fact.name.indexOf('/')
  return { group: fact.name.slice(0, slash), name: fact.name.slice(slash + 1) }
}

function purlOf(fact: DependencyFact): string | undefined {
  const type = PURL_TYPE[fact.ecosystem]
  if (!type || isRange(fact.version)) return undefined
  return `pkg:${type}/${fact.name.replace(/^@/, '%40')}@${fact.version}`
}

export function renderCycloneDx(
  dependencies: DependencyFact[],
  manifests: ManifestRecord[],
  meta: SpdxMeta
): CdxDocument {
  const byRef = new Map<string, { facts: DependencyFact[] }>()
  const refOf = (f: DependencyFact) =>
    `${f.ecosystem}:${f.name}@${isRange(f.version) ? `range:${f.version}` : f.version}`
  for (const fact of dependencies) {
    const ref = refOf(fact)
    byRef.set(ref, { facts: [...(byRef.get(ref)?.facts ?? []), fact] })
  }

  const components: CdxComponent[] = []
  for (const ref of [...byRef.keys()].sort()) {
    const facts = byRef.get(ref)!.facts
    const first = facts[0]
    const ranged = isRange(first.version)
    const hashes = checksumsOf(first.integrity).map((c) => ({
      alg: ALG[c.algorithm],
      content: c.checksumValue,
    }))
    const location = locatorOf(first.resolved)
    const importers = [...new Set(facts.flatMap((f) => f.importers))].sort()
    const properties = facts.map((f) => ({
      name: 'cia:declared-as',
      value: `${f.kind} in ${f.manifest}${f.line === null ? '' : ` line ${f.line}`}`,
    }))
    if (ranged)
      properties.push({
        name: 'cia:declared-range',
        value: `${first.version} — no lockfile pinned it at this commit, so no version is asserted`,
      })
    const purl = purlOf(first)
    components.push({
      'type': 'library',
      'bom-ref': ref,
      ...groupAndName(first),
      ...(ranged ? {} : { version: first.version }),
      ...(purl ? { purl } : {}),
      ...(facts.some((f) => f.kind === 'direct') ? { scope: 'required' as const } : {}),
      ...(hashes.length ? { hashes } : {}),
      ...(location !== 'NOASSERTION'
        ? { externalReferences: [{ type: 'distribution' as const, url: location }] }
        : {}),
      ...(importers.length
        ? { evidence: { occurrences: importers.map((file) => ({ location: file })) } }
        : {}),
      properties,
    })
  }

  const unread = manifests.filter((m) => m.status === 'unread')
  const complete = unread.length === 0 && !dependencies.some((d) => isRange(d.version))
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: serialFor(meta),
    version: 1,
    metadata: {
      timestamp: meta.at,
      lifecycles: [{ phase: 'pre-build' }],
      tools: { components: [{ type: 'application', name: 'code-intelligence-assistant' }] },
      component: {
        'type': 'application',
        'bom-ref': 'root',
        'name': meta.name,
        'version': meta.commit,
      },
      properties: [
        {
          name: 'cia:source',
          value: `the manifests committed at ${meta.commit}, not an installed dependency tree; nothing was fetched`,
        },
        ...unread.map((m) => ({
          name: 'cia:manifest-unread',
          value: `${m.path} (${m.ecosystem})`,
        })),
      ],
    },
    components,
    compositions: [{ aggregate: complete ? 'complete' : 'incomplete' }],
  }
}
