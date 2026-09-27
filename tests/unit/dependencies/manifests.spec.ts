import { test } from '@japa/runner'
import { readManifests } from '#app/dependencies/manifests'

/**
 * Dependencies from every manifest at the commit. Expected rows
 * are hand-written from the fixture text: name, version, kind and the line
 * the declaration sits on, so each row is citable.
 */
test.group('manifest readers', () => {
  test('build.gradle: string and map notations, configurations to kinds, a catalog reference kept literal', async ({
    assert,
  }) => {
    const gradle = [
      "apply plugin: 'com.android.application'",
      '',
      'dependencies {',
      "    implementation 'androidx.appcompat:appcompat:1.6.1'",
      '    api "com.google.code.gson:gson:2.10.1"',
      "    testImplementation 'junit:junit:4.13.2'",
      "    implementation group: 'com.squareup.okhttp3', name: 'okhttp', version: '4.12.0'",
      '    implementation libs.retrofit',
      "    kapt 'com.github.bumptech.glide:compiler:4.16.0'",
      "    implementation project(':common')",
      '}',
    ].join('\n')
    const { dependencies, manifests } = await readManifests({ 'app/build.gradle': gradle })
    assert.deepEqual(
      dependencies.map((d) => [d.ecosystem, d.name, d.version, d.kind, d.manifest, d.line]),
      [
        ['gradle', 'androidx.appcompat:appcompat', '1.6.1', 'direct', 'app/build.gradle', 4],
        ['gradle', 'com.google.code.gson:gson', '2.10.1', 'direct', 'app/build.gradle', 5],
        ['gradle', 'junit:junit', '4.13.2', 'dev', 'app/build.gradle', 6],
        ['gradle', 'com.squareup.okhttp3:okhttp', '4.12.0', 'direct', 'app/build.gradle', 7],
        ['gradle', 'libs.retrofit', 'libs.retrofit', 'direct', 'app/build.gradle', 8],
        ['gradle', 'com.github.bumptech.glide:compiler', '4.16.0', 'direct', 'app/build.gradle', 9],
      ]
    )
    // A project() dependency is a module of the build, not a package.
    assert.deepEqual(manifests, [
      { path: 'app/build.gradle', ecosystem: 'gradle', status: 'read', dependencies: 6 },
    ])
  }).tags(['AC-WP11-03', 'wp11'])

  test('a Gradle catalog reference resolves through gradle/libs.versions.toml to its coordinates and version; one the catalog lacks stays literal', async ({
    assert,
  }) => {
    const { dependencies, manifests } = await readManifests({
      'app/build.gradle.kts': [
        'dependencies {',
        '    implementation(libs.material)',
        '    implementation(libs.androidx.room.runtime)',
        '    ksp(libs.androidx.room.compiler)',
        '    implementation(libs.missing)',
        '}',
      ].join('\n'),
      'gradle/libs.versions.toml': [
        '[versions]',
        'material = "1.12.0"',
        'room = "2.6.1"',
        '',
        '[libraries]',
        'material = { group = "com.google.android.material", name = "material", version.ref = "material" }',
        'androidx-room-runtime = { module = "androidx.room:room-runtime", version.ref = "room" }',
        'androidx_room_compiler = "androidx.room:room-compiler:2.6.1"',
      ].join('\n'),
    })
    assert.deepEqual(
      dependencies.map((d) => [d.name, d.version, d.kind, d.manifest, d.line]),
      [
        ['com.google.android.material:material', '1.12.0', 'direct', 'app/build.gradle.kts', 2],
        ['androidx.room:room-runtime', '2.6.1', 'direct', 'app/build.gradle.kts', 3],
        ['androidx.room:room-compiler', '2.6.1', 'direct', 'app/build.gradle.kts', 4],
        ['libs.missing', 'libs.missing', 'direct', 'app/build.gradle.kts', 5],
      ]
    )
    // The catalog is a manifest the index read: its entries are resolved into the build scripts' rows.
    assert.deepEqual(
      manifests.find((m) => m.path === 'gradle/libs.versions.toml'),
      { path: 'gradle/libs.versions.toml', ecosystem: 'gradle', status: 'read', dependencies: 0 }
    )
  }).tags(['AC-WP11-03', 'wp11'])

  test('package.json anywhere in the tree, with the lockfile beside it; a lockfile or Podfile alone is a manifest the index names but does not read', async ({
    assert,
  }) => {
    const pkg = JSON.stringify(
      { name: 'app', dependencies: { express: '^4.19.0' }, devDependencies: { vitest: '^2.0.0' } },
      null,
      2
    )
    const { dependencies, manifests } = await readManifests({
      'smartyoutubetv/package.json':
        '{\n  "name": "smartyoutubetv",\n  "dependencies": {\n    \n  }\n}\n',
      'web/package.json': pkg,
      'web/yarn.lock': '# yarn lockfile v1',
      'ios/Podfile': "pod 'Alamofire'",
    })
    assert.deepEqual(
      dependencies.map((d) => [d.ecosystem, d.name, d.version, d.kind, d.manifest, d.line]),
      [
        ['npm', 'express', '^4.19.0', 'direct', 'web/package.json', 4],
        ['npm', 'vitest', '^2.0.0', 'dev', 'web/package.json', 7],
      ]
    )
    assert.deepEqual(manifests, [
      { path: 'ios/Podfile', ecosystem: 'cocoapods', status: 'unread', dependencies: 0 },
      { path: 'smartyoutubetv/package.json', ecosystem: 'npm', status: 'read', dependencies: 0 },
      { path: 'web/package.json', ecosystem: 'npm', status: 'read', dependencies: 2 },
      { path: 'web/yarn.lock', ecosystem: 'npm', status: 'unread', dependencies: 0 },
    ])
  }).tags(['AC-WP11-03', 'wp11'])

  test('pom.xml, requirements.txt, pyproject.toml, go.mod, Cargo.toml, Gemfile and Package.swift: one row per declaration with its line', async ({
    assert,
  }) => {
    const cases: Array<{
      path: string
      text: string
      rows: Array<[string, string, string, string, number]>
    }> = [
      {
        path: 'pom.xml',
        text: [
          '<project>',
          '  <dependencies>',
          '    <dependency>',
          '      <groupId>org.springframework</groupId>',
          '      <artifactId>spring-core</artifactId>',
          '      <version>6.1.0</version>',
          '    </dependency>',
          '    <dependency>',
          '      <groupId>junit</groupId>',
          '      <artifactId>junit</artifactId>',
          '      <version>${junit.version}</version>',
          '      <scope>test</scope>',
          '    </dependency>',
          '  </dependencies>',
          '</project>',
        ].join('\n'),
        rows: [
          ['maven', 'org.springframework:spring-core', '6.1.0', 'direct', 3],
          ['maven', 'junit:junit', '${junit.version}', 'dev', 8],
        ],
      },
      {
        path: 'api/requirements.txt',
        text: ['# web', 'flask==3.0.2', 'requests>=2.31,<3', '-r base.txt', 'numpy'].join('\n'),
        rows: [
          ['pypi', 'flask', '==3.0.2', 'direct', 2],
          ['pypi', 'requests', '>=2.31,<3', 'direct', 3],
          ['pypi', 'numpy', '', 'direct', 5],
        ],
      },
      {
        path: 'pyproject.toml',
        text: [
          '[project]',
          'name = "svc"',
          'dependencies = [',
          '  "httpx>=0.27",',
          '  "pydantic==2.7.0",',
          ']',
          '[project.optional-dependencies]',
          'test = ["pytest>=8"]',
        ].join('\n'),
        rows: [
          ['pypi', 'httpx', '>=0.27', 'direct', 4],
          ['pypi', 'pydantic', '==2.7.0', 'direct', 5],
          ['pypi', 'pytest', '>=8', 'dev', 8],
        ],
      },
      {
        path: 'go.mod',
        text: [
          'module example.com/svc',
          'go 1.22',
          'require github.com/gin-gonic/gin v1.9.1',
          'require (',
          '\tgolang.org/x/net v0.25.0',
          '\tgithub.com/stretchr/testify v1.9.0 // indirect',
          ')',
        ].join('\n'),
        rows: [
          ['go', 'github.com/gin-gonic/gin', 'v1.9.1', 'direct', 3],
          ['go', 'golang.org/x/net', 'v0.25.0', 'direct', 5],
          ['go', 'github.com/stretchr/testify', 'v1.9.0', 'transitive', 6],
        ],
      },
      {
        path: 'Cargo.toml',
        text: [
          '[package]',
          'name = "svc"',
          '[dependencies]',
          'serde = "1.0"',
          'tokio = { version = "1.37", features = ["full"] }',
          '[dev-dependencies]',
          'proptest = "1.4"',
        ].join('\n'),
        rows: [
          ['cargo', 'serde', '1.0', 'direct', 4],
          ['cargo', 'tokio', '1.37', 'direct', 5],
          ['cargo', 'proptest', '1.4', 'dev', 7],
        ],
      },
      {
        path: 'Gemfile',
        text: [
          "source 'https://rubygems.org'",
          "gem 'rails', '~> 7.1'",
          'group :test do',
          "  gem 'rspec'",
          'end',
        ].join('\n'),
        rows: [
          ['rubygems', 'rails', '~> 7.1', 'direct', 2],
          ['rubygems', 'rspec', '', 'dev', 4],
        ],
      },
      {
        path: 'Package.swift',
        text: [
          '// swift-tools-version:5.9',
          'import PackageDescription',
          'let package = Package(',
          '  name: "App",',
          '  dependencies: [',
          '    .package(url: "https://github.com/Alamofire/Alamofire.git", from: "5.9.0"),',
          '    .package(url: "https://github.com/apple/swift-argument-parser", exact: "1.3.0"),',
          '  ]',
          ')',
        ].join('\n'),
        rows: [
          ['swiftpm', 'Alamofire', 'from: 5.9.0', 'direct', 6],
          ['swiftpm', 'swift-argument-parser', 'exact: 1.3.0', 'direct', 7],
        ],
      },
    ]
    for (const c of cases) {
      const { dependencies, manifests } = await readManifests({ [c.path]: c.text })
      assert.deepEqual(
        dependencies.map((d) => [d.ecosystem, d.name, d.version, d.kind, d.line]),
        c.rows,
        c.path
      )
      assert.equal(manifests[0]?.status, 'read', c.path)
      assert.equal(manifests[0]?.dependencies, c.rows.length, c.path)
    }
  }).tags(['AC-WP11-03', 'wp11'])
})
