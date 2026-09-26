import { test } from '@japa/runner'
import { mergeRoots, renderSpdx } from '#app/dependencies/spdx'
import type { DependencyFact } from '#app/dependencies/extractor'
import type { ManifestRecord } from '#app/dependencies/manifests'

/**
 *: the document never states a version it did not read. A declared range is
 * `NOASSERTION` with the range annotated, because a scanner reading `^4.18.0` as a version matches
 * the wrong advisories — a wrong CVE match is worse than a blank one.
 */
const META = {
  name: 'node-express-shop',
  commit: 'a'.repeat(40),
  at: '2026-09-19T00:00:00.000Z',
}

const fact = (over: Partial<DependencyFact>): DependencyFact => ({
  ecosystem: 'npm',
  name: 'express',
  version: '4.18.2',
  kind: 'direct',
  integrity: 'sha512-abc',
  resolved: 'https://registry.npmjs.org/express/-/express-4.18.2.tgz',
  importers: ['src/app.ts'],
  manifest: 'package.json',
  line: 12,
  ...over,
})

test.group('SPDX export', () => {
  test('a locked version is stated; a declared range is NOASSERTION with the range annotated', ({
    assert,
  }) => {
    const doc = renderSpdx(
      [fact({}), fact({ name: 'lodash', version: '^4.17.0', integrity: null, resolved: null })],
      [],
      META
    )
    const express = doc.packages.find((p) => p.name === 'express')!
    const lodash = doc.packages.find((p) => p.name === 'lodash')!
    assert.equal(express.versionInfo, '4.18.2')
    assert.equal(lodash.versionInfo, 'NOASSERTION', 'a range is not a version')
    assert.notInclude(
      JSON.stringify(lodash.versionInfo),
      '^',
      'the range never reaches versionInfo'
    )
    assert.isTrue(
      lodash.annotations!.some((a) => a.comment.includes('declared range ^4.17.0')),
      'the range is still reported, just not as a version'
    )
  }).tags(['AC-WP15-03', 'wp15'])

  test('the header names every manifest recognised and unread, so an empty result is not an unparsed one', ({
    assert,
  }) => {
    const manifests: ManifestRecord[] = [
      { path: 'package.json', ecosystem: 'npm', status: 'read', dependencies: 2 },
      { path: 'ios/Podfile.lock', ecosystem: 'cocoapods', status: 'unread', dependencies: 0 },
    ]
    const comment = renderSpdx([fact({})], manifests, META).creationInfo.comment
    assert.include(comment, '1 manifest(s) read, 1 recognised and unread: ios/Podfile.lock')
    assert.include(comment, 'not from an installed dependency tree')
    assert.include(comment, 'Nothing was fetched')
    assert.include(comment, 'NOASSERTION wherever no licence was read')
  }).tags(['AC-WP15-03', 'wp15'])

  test('a package nothing imports says no import was found, and never that it is unused', ({
    assert,
  }) => {
    const doc = renderSpdx(
      [fact({ importers: [] }), fact({ name: 'zod', importers: ['a.ts', 'b.ts'] })],
      [],
      META
    )
    const orphan = doc.packages.find((p) => p.name === 'express')!
    const used = doc.packages.find((p) => p.name === 'zod')!
    assert.isTrue(orphan.annotations!.some((a) => a.comment.startsWith('no import found')))
    assert.isFalse(
      orphan.annotations!.some((a) =>
        /\bunused\b/.test(a.comment.replace('not a claim that it is unused', ''))
      ),
      'absence of an import is not a claim of disuse'
    )
    assert.isTrue(
      used.annotations!.some((a) => a.comment.includes('imported by 2 file(s): a.ts, b.ts'))
    )
  }).tags(['AC-WP15-03', 'wp15'])

  // Canary for the assertion that matters most: a scanner keys off the purl. If a ranged package
  // ever grew one, the document would match advisories for a version the commit never pinned.
  test('a ranged package carries no purl, so no scanner can match a version it was never pinned to', ({
    assert,
  }) => {
    const doc = renderSpdx(
      [fact({ name: 'lodash', version: '^4.17.0', integrity: null, resolved: null })],
      [],
      META
    )
    const lodash = doc.packages[0]
    assert.isUndefined(lodash.externalRefs)
    assert.isUndefined(lodash.checksums, 'nothing was read, so nothing is claimed')
    assert.equal(lodash.downloadLocation, 'NOASSERTION')
    assert.notInclude(JSON.stringify(doc), 'pkg:npm/lodash')
  }).tags(['AC-WP15-03', 'wp15'])

  test('a resolved package carries a purl and its integrity as a checksum', ({ assert }) => {
    const doc = renderSpdx([fact({ name: '@adonisjs/core', version: '6.19.0' })], [], META)
    const pkg = doc.packages[0]
    assert.deepEqual(pkg.externalRefs, [
      {
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: 'pkg:npm/%40adonisjs/core@6.19.0',
      },
    ])
    // SPDX 2.3 wants lowercase hex; a lockfile's integrity is SRI (`sha512-<base64>`). The earlier
    // version of this test asserted the SRI string verbatim, which no SPDX validator accepts.
    assert.deepEqual(pkg.checksums, [
      { algorithm: 'SHA512', checksumValue: Buffer.from('abc', 'base64').toString('hex') },
    ])
    assert.equal(doc.spdxVersion, 'SPDX-2.3')
    assert.equal(doc.relationships[0].relatedSpdxElement, pkg.SPDXID)
  }).tags(['AC-WP15-03', 'wp15'])

  test('the same commit renders the same document, so the pack digest is reproducible', ({
    assert,
  }) => {
    const rows = [fact({}), fact({ name: 'zod', version: '3.25.0' })]
    assert.deepEqual(renderSpdx(rows, [], META), renderSpdx([...rows].reverse(), [], META))
  }).tags(['AC-WP15-03', 'wp15'])

  test('several roots merge into one document, each row keeping the manifest it came from', ({
    assert,
  }) => {
    const merged = mergeRoots([
      {
        prefix: '',
        dependencies: [fact({ name: 'express' })],
        manifests: [{ path: 'package.json', ecosystem: 'npm', status: 'read', dependencies: 1 }],
      },
      {
        prefix: 'services/llm-gateway',
        dependencies: [fact({ name: 'undici', manifest: 'package-lock.json', line: null })],
        manifests: [
          { path: 'package-lock.json', ecosystem: 'npm', status: 'read', dependencies: 1 },
        ],
      },
    ])
    assert.deepEqual(
      merged.dependencies.map((d) => d.manifest).sort(),
      ['package.json', 'services/llm-gateway/package-lock.json'],
      'a nested root’s rows are repo-relative, so the citation still resolves'
    )
    assert.deepEqual(merged.manifests.map((m) => m.path).sort(), [
      'package.json',
      'services/llm-gateway/package-lock.json',
    ])
  }).tags(['AC-WP15-03', 'wp15'])

  test('one package declared by two roots keeps both declarations, not whichever was seen first', ({
    assert,
  }) => {
    // The bug this replaces: keying on (ecosystem, name, version) alone kept the root's *dev*
    // declaration of @azure/identity and dropped the gateway's runtime one, so the document said
    // "dev dependency" about a package that ships in a service image.
    const merged = mergeRoots([
      {
        prefix: '',
        dependencies: [fact({ name: '@azure/identity', version: '4.13.2', kind: 'dev' })],
        manifests: [],
      },
      {
        prefix: 'services/llm-gateway',
        dependencies: [fact({ name: '@azure/identity', version: '4.13.2', kind: 'direct' })],
        manifests: [],
      },
    ])
    assert.lengthOf(merged.dependencies, 2, 'both declarations survive the merge')
    const doc = renderSpdx(merged.dependencies, [], META)
    assert.lengthOf(doc.packages, 1, 'but they are one package in the document')
    const comments = doc.packages[0].annotations!.map((a) => a.comment)
    assert.isTrue(comments.some((c) => c.includes('package.json line 12 as a dev dependency')))
    assert.isTrue(
      comments.some((c) =>
        c.includes('services/llm-gateway/package.json line 12 as a direct dependency')
      ),
      'the declaration that means the package ships is not the one that gets dropped'
    )
  }).tags(['AC-WP15-03', 'wp15'])

  test('two versions of one package are two packages, never a silent winner', ({ assert }) => {
    const doc = renderSpdx(
      [fact({ name: 'zod', version: '3.25.0' }), fact({ name: 'zod', version: '3.24.1' })],
      [],
      META
    )
    assert.deepEqual(doc.packages.map((p) => p.versionInfo).sort(), ['3.24.1', '3.25.0'])
  }).tags(['AC-WP15-03', 'wp15'])

  test('the same declaration read twice is not reported twice', ({ assert }) => {
    const rows = [fact({ name: 'zod', version: '3.25.0' })]
    const merged = mergeRoots([
      { prefix: '', dependencies: rows, manifests: [] },
      { prefix: '', dependencies: rows, manifests: [] },
    ])
    assert.lengthOf(merged.dependencies, 1)
  }).tags(['AC-WP15-03', 'wp15'])

  // AC-WP21-03. `resolved` is repository content: a lockfile can say anything, and a private
  // registry's URL can carry a token. The document carries a locator, never a credential.
  test('a download location is only an http(s) or git URL, stripped of credentials, query and fragment', ({
    assert,
  }) => {
    const location = (resolved: string) =>
      renderSpdx([fact({ resolved })], [], META).packages[0].downloadLocation
    assert.equal(
      location('https://registry.npmjs.org/express/-/express-4.18.2.tgz'),
      'https://registry.npmjs.org/express/-/express-4.18.2.tgz'
    )
    assert.equal(
      location('https://ci:s3cr3t-token@npm.internal.example/express/-/express-4.18.2.tgz'),
      'https://npm.internal.example/express/-/express-4.18.2.tgz',
      'userinfo is a credential and never reaches the document'
    )
    assert.equal(
      location('https://npm.internal.example/express.tgz?token=abc#frag'),
      'https://npm.internal.example/express.tgz'
    )
    assert.equal(
      location('git+ssh://git@github.com/acme/lib.git#6f1c2d0'),
      'git+ssh://github.com/acme/lib.git'
    )
    for (const hostile of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/plain,hi',
      'not a url',
      '',
    ]) {
      assert.equal(location(hostile), 'NOASSERTION', hostile)
    }
  }).tags(['AC-WP21-03', 'wp21'])

  test('an SRI integrity becomes an SPDX checksum per hash, in hex, and an unreadable one becomes none', ({
    assert,
  }) => {
    const b64 = Buffer.from('0123456789abcdef0123456789abcdef', 'hex').toString('base64')
    const sums = (integrity: string | null) =>
      renderSpdx([fact({ integrity })], [], META).packages[0].checksums
    assert.deepEqual(sums(`sha512-${b64}`), [
      { algorithm: 'SHA512', checksumValue: '0123456789abcdef0123456789abcdef' },
    ])
    assert.deepEqual(sums(`sha1-${b64} sha256-${b64}`), [
      { algorithm: 'SHA1', checksumValue: '0123456789abcdef0123456789abcdef' },
      { algorithm: 'SHA256', checksumValue: '0123456789abcdef0123456789abcdef' },
    ])
    assert.isUndefined(sums('md4-xyz'), 'an algorithm SPDX does not name is not guessed at')
    assert.isUndefined(sums('not-an-sri-at-all'))
    assert.isUndefined(sums(null))
  }).tags(['AC-WP21-02', 'wp21'])
})
