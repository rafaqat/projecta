import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { extractAllDependencies, extractDependencies, packageOf } from '#app/dependencies/extractor'
import { extractSurface } from '#app/dependencies/surface'

const FIXTURE = 'evals/fixtures/node-express-shop'

test.group('Dependency extractor and Tier 1 surface', () => {
  test('Tier 0 records locked versions, direct/dev/transitive kind, integrity and importers, never following resolved', async ({
    assert,
  }) => {
    const files: Record<string, string> = {}
    for (const path of [
      'package.json',
      'package-lock.json',
      'src/app.ts',
      'src/routes/orders.ts',
      'src/services/PaymentService.ts',
    ])
      files[path] = await readFile(`${FIXTURE}/${path}`, 'utf8')
    const deps = await extractDependencies(files)
    const express = deps.find((d) => d.name === 'express')!
    assert.equal(express.version, '4.19.2')
    assert.equal(express.kind, 'direct')
    assert.match(express.integrity ?? '', /^sha512-/)
    assert.deepEqual(express.importers, ['src/app.ts', 'src/routes/orders.ts'])
    assert.equal(deps.find((d) => d.name === 'typescript')!.kind, 'dev')
    // The fixture lockfile is flat; a nested lockfile entry is transitive.
    const nested = await extractDependencies({
      'package.json': '{"dependencies":{"a":"1.0.0"}}',
      'package-lock.json': JSON.stringify({
        packages: {
          'node_modules/a': { version: '1.0.0' },
          'node_modules/a/node_modules/b': { version: '2.0.0' },
        },
      }),
    })
    assert.deepEqual(
      nested.map((d) => `${d.name}@${d.version}:${d.kind}`),
      ['a@1.0.0:direct', 'b@2.0.0:transitive']
    )
    assert.equal(packageOf('@nestjs/common/decorators'), '@nestjs/common')
    assert.equal(packageOf('./routes/orders.js'), null)
    assert.equal(packageOf('@services/PaymentService'), '@services/PaymentService')
  }).tags(['AC-WP11-02', 'wp11'])

  test('every manifest at the commit is read: a locked row cites its manifest line, a nested manifest and a Gradle build are rows too, and an unread lockfile is named', async ({
    assert,
  }) => {
    const { dependencies, manifests } = await extractAllDependencies({
      'package.json': '{\n  "dependencies": {\n    "a": "^1.0.0"\n  }\n}',
      'package-lock.json': JSON.stringify({
        packages: {
          'node_modules/a': { version: '1.0.0' },
          'node_modules/a/node_modules/b': { version: '2.0.0' },
        },
      }),
      'web/package.json': '{\n  "devDependencies": {\n    "vitest": "^2"\n  }\n}',
      'web/yarn.lock': '# yarn lockfile v1',
      'android/app/build.gradle':
        "dependencies {\n    implementation 'com.google.code.gson:gson:2.10.1'\n}",
    })
    assert.deepEqual(
      dependencies.map((d) => [d.ecosystem, d.name, d.version, d.kind, d.manifest, d.line]),
      [
        ['npm', 'a', '1.0.0', 'direct', 'package.json', 3],
        ['npm', 'b', '2.0.0', 'transitive', 'package-lock.json', null],
        ['gradle', 'com.google.code.gson:gson', '2.10.1', 'direct', 'android/app/build.gradle', 2],
        ['npm', 'vitest', '^2', 'dev', 'web/package.json', 3],
      ]
    )
    assert.deepEqual(
      manifests.map((m) => [m.path, m.status, m.dependencies]),
      [
        ['android/app/build.gradle', 'read', 1],
        ['package-lock.json', 'read', 1],
        ['package.json', 'read', 1],
        ['web/package.json', 'read', 1],
        ['web/yarn.lock', 'unread', 0],
      ]
    )
    // A one-line manifest gives the line reader nothing; the declaration is still a row, without a line.
    const terse = await extractAllDependencies({
      'package.json': '{"dependencies":{"a":"^1.0.0"}}',
    })
    assert.deepEqual(
      terse.dependencies.map((d) => [d.name, d.version, d.manifest, d.line]),
      [['a', '^1.0.0', 'package.json', null]]
    )
  }).tags(['AC-WP11-03', 'wp11'])

  test('Tier 1 surface lists exported declarations and the members of an `export =` namespace', async ({
    assert,
  }) => {
    const surface = await extractSurface(
      new Map([
        [
          'index.d.ts',
          [
            'declare function e(): core.Express;',
            'declare namespace e {',
            '  function Router(options?: RouterOptions): core.Router;',
            '  interface Application extends core.Application {}',
            '  var json: typeof bodyParser.json;',
            '}',
            'declare namespace hidden { function secret(): void }',
            'export = e;',
            'export declare function z(): void;',
            'export interface Router { get(p: string): void }',
            'export const VERSION: string;',
          ].join('\n'),
        ],
        ['package.json', '{}'],
      ])
    )
    assert.sameMembers(
      surface.map((s) => `${s.kind}:${s.name}`),
      [
        'function:e',
        'namespace:e',
        'function:e.Router',
        'interface:e.Application',
        'variable:e.json',
        'function:z',
        'interface:Router',
        'variable:VERSION',
      ]
    )
    assert.equal(surface.find((s) => s.name === 'e.Router')!.line, 3)
  }).tags(['AC-WP11-02', 'wp11'])
})
