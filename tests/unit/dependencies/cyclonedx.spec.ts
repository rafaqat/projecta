import { test } from '@japa/runner'
import { createRequire } from 'node:module'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renderCycloneDx } from '#app/dependencies/cyclonedx'
import { extractAllDependencies, type DependencyFact } from '#app/dependencies/extractor'

/**
 *: the dependency export in CycloneDX 1.6. The schema is the official one, vendored under
 * tests/fixtures/cyclonedx so validation needs no network. `ajv` is only a transitive dependency
 * today; it is used here in a test and nowhere at runtime (dependency request raised in WP-22).
 */
const require = createRequire(import.meta.url)
const SCHEMAS = 'tests/fixtures/cyclonedx'
const SHOP = 'evals/fixtures/node-express-shop'

async function validator() {
  const Ajv = require('ajv')
  // The schema uses the `iri-reference` format, which ajv 6 does not know; ignoring an unknown
  // format skips that one check and nothing else.
  const ajv = new Ajv({
    schemaId: 'auto',
    unknownFormats: 'ignore',
    allErrors: true,
    logger: false,
  })
  for (const file of ['spdx.schema.json', 'jsf-0.82.schema.json'])
    ajv.addSchema(JSON.parse(await readFile(join(SCHEMAS, file), 'utf8')))
  return ajv.compile(JSON.parse(await readFile(join(SCHEMAS, 'bom-1.6.schema.json'), 'utf8')))
}

async function shopFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const entry of await readdir(SHOP, { recursive: true })) {
    if (/(^|\/)[\w-]+\.manifest\.json$/.test(entry)) continue
    const text = await readFile(join(SHOP, entry), 'utf8').catch(() => null)
    if (text !== null) files[entry] = text
  }
  return files
}

const META = { name: 'node-express-shop', commit: 'a'.repeat(40), at: '2026-09-19T00:00:00.000Z' }

const fact = (over: Partial<DependencyFact>): DependencyFact => ({
  ecosystem: 'npm',
  name: 'express',
  version: '4.18.2',
  kind: 'direct',
  integrity: `sha512-${Buffer.from('0123456789abcdef', 'hex').toString('base64')}`,
  resolved: 'https://registry.npmjs.org/express/-/express-4.18.2.tgz',
  importers: ['src/app.ts'],
  manifest: 'package.json',
  line: 12,
  ...over,
})

test.group('CycloneDX export', () => {
  test('the fixture repository’s document validates against the official CycloneDX 1.6 schema', async ({
    assert,
  }) => {
    const { dependencies, manifests } = await extractAllDependencies(await shopFiles())
    assert.isAbove(dependencies.length, 0)
    const bom = renderCycloneDx(dependencies, manifests, META)
    const validate = await validator()
    const valid = validate(bom)
    assert.isTrue(valid, JSON.stringify(validate.errors?.slice(0, 5), null, 2))
    assert.equal(bom.bomFormat, 'CycloneDX')
    assert.equal(bom.specVersion, '1.6')
  }).tags(['AC-WP22-01', 'wp22'])

  test('a ranged package has no version and no purl, and its range is a property', ({ assert }) => {
    const bom = renderCycloneDx(
      [fact({ name: 'lodash', version: '^4.17.0', integrity: null, resolved: null })],
      [],
      META
    )
    const lodash = bom.components[0]
    assert.notProperty(lodash, 'version', 'a range is not a version')
    assert.notProperty(lodash, 'purl', 'no scanner can match a version the commit never pinned')
    assert.isTrue(
      lodash.properties!.some(
        (p) => p.name === 'cia:declared-range' && p.value.startsWith('^4.17.0')
      )
    )
    assert.notInclude(JSON.stringify(bom), 'pkg:npm/lodash')
  }).tags(['AC-WP22-02', 'wp22'])

  test('completeness is stated in compositions: complete only with no unread manifest and no range', ({
    assert,
  }) => {
    const read = {
      path: 'package.json',
      ecosystem: 'npm' as const,
      status: 'read' as const,
      dependencies: 1,
    }
    const unread = {
      path: 'ios/Podfile.lock',
      ecosystem: 'cocoapods' as const,
      status: 'unread' as const,
      dependencies: 0,
    }
    assert.equal(renderCycloneDx([fact({})], [read], META).compositions[0].aggregate, 'complete')
    const gap = renderCycloneDx([fact({})], [read, unread], META)
    assert.equal(gap.compositions[0].aggregate, 'incomplete')
    assert.deepInclude(gap.metadata.properties, {
      name: 'cia:manifest-unread',
      value: 'ios/Podfile.lock (cocoapods)',
    })
    assert.equal(
      renderCycloneDx([fact({ version: '~1.2.0' })], [read], META).compositions[0].aggregate,
      'incomplete',
      'a package with no pinned version makes the inventory incomplete'
    )
    assert.deepEqual(gap.metadata.lifecycles, [{ phase: 'pre-build' }])
  }).tags(['AC-WP22-02', 'wp22'])

  test('importing files are occurrences, and a package nothing imports has none — never "unused"', ({
    assert,
  }) => {
    const bom = renderCycloneDx(
      [
        fact({ importers: ['src/b.ts', 'src/a.ts'] }),
        fact({ name: 'zod', version: '3.25.0', importers: [] }),
      ],
      [],
      META
    )
    const express = bom.components.find((c) => c.name === 'express')!
    const zod = bom.components.find((c) => c.name === 'zod')!
    assert.deepEqual(express.evidence, {
      occurrences: [{ location: 'src/a.ts' }, { location: 'src/b.ts' }],
    })
    assert.notProperty(zod, 'evidence')
    assert.notMatch(JSON.stringify(bom), /\bunused\b/i)
  }).tags(['AC-WP22-02', 'wp22'])

  test('scope is required only for a runtime declaration, and never excluded', ({ assert }) => {
    // @azure/identity: dev in the application, runtime in llm-gateway — one package, both declarations.
    const bom = renderCycloneDx(
      [
        fact({
          name: '@azure/identity',
          version: '4.13.2',
          kind: 'dev',
          manifest: 'package.json',
          line: 51,
        }),
        fact({
          name: '@azure/identity',
          version: '4.13.2',
          kind: 'direct',
          manifest: 'services/llm-gateway/package.json',
          line: 11,
        }),
        fact({ name: 'typescript', version: '5.9.2', kind: 'dev' }),
        fact({
          name: 'ms',
          version: '2.1.3',
          kind: 'transitive',
          manifest: 'package-lock.json',
          line: null,
        }),
      ],
      [],
      META
    )
    const azure = bom.components.find((c) => c.name === 'identity')!
    assert.equal(azure.group, '@azure')
    assert.equal(azure.scope, 'required', 'shipped by a service, whatever the application declares')
    assert.lengthOf(
      azure.properties!.filter((p) => p.name === 'cia:declared-as'),
      2,
      'both declarations kept'
    )
    assert.notProperty(
      bom.components.find((c) => c.name === 'typescript')!,
      'scope'
    )
    assert.notProperty(
      bom.components.find((c) => c.name === 'ms')!,
      'scope'
    )
    assert.notInclude(JSON.stringify(bom), '"excluded"')
  }).tags(['AC-WP22-02', 'wp22'])

  test('hashes are hex under CycloneDX algorithm names, and a distribution URL carries no credential or query', ({
    assert,
  }) => {
    const bom = renderCycloneDx(
      [
        fact({ resolved: 'https://ci:s3cr3t@npm.internal.example/express.tgz?token=abc#x' }),
        fact({ name: 'evil', version: '1.0.0', resolved: 'javascript:alert(1)' }),
      ],
      [],
      META
    )
    const express = bom.components.find((c) => c.name === 'express')!
    assert.deepEqual(express.hashes, [{ alg: 'SHA-512', content: '0123456789abcdef' }])
    assert.deepEqual(express.externalReferences, [
      { type: 'distribution', url: 'https://npm.internal.example/express.tgz' },
    ])
    assert.notInclude(JSON.stringify(bom), 's3cr3t')
    assert.notInclude(JSON.stringify(bom), 'token=')
    assert.notProperty(
      bom.components.find((c) => c.name === 'evil')!,
      'externalReferences'
    )
  }).tags(['AC-WP22-02', 'wp22'])
})
