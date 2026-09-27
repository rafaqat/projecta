import { test } from '@japa/runner'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { GitRunner, HistoryFetchError } from '#app/ingest/git_runner'
import {
  FIXTURE_BASE,
  SLOW_MS,
  buildFixtureHistory,
  fixtureBlobAt,
  fixtureRequests,
  startFixtureGitServer,
} from '#tests/helpers/git_fixtures'

const run = promisify(execFile)

/**
 * History without contents. A fetch with
 * `--filter=blob:none` records a promisor remote, and git then fetches any
 * missing blob on demand: a secret deleted from the tree comes back from
 * history. Two independent controls stop it — the promisor configuration
 * is removed, and every invocation sets `GIT_NO_LAZY_FETCH=1` — and each is
 * proven on its own. A positive control shows the leak with both off, so
 * the test can fail.
 */
const SECRET = 'FIXTURE-CANARY-history-secret-3b9e'

async function historyRepo(name: string, allowFilter = true) {
  return buildFixtureHistory(
    'history',
    name,
    [
      {
        entries: {
          'src/a.ts': 'export const a = 1\n',
          'src/b.ts': 'export const b = 1\n',
          's.env': `TOKEN=${SECRET}\n`,
        },
      },
      { entries: { 'src/a.ts': 'export const a = 2\n', 'src/b.ts': 'export const b = 2\n' } },
      { entries: { 'src/a.ts': 'export const a = 3\n', 'src/b.ts': 'export const b = 3\n' } },
      { remove: ['s.env'] },
    ],
    { allowFilter }
  )
}

/** The ingest sequence up to history: init, tip fetch, resolve, history fetch. */
async function ingestHistory(url: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'cochange-'))
  const runner = new GitRunner({ cwd })
  await runner.init()
  await runner.fetch(url, 'main')
  const commit = await runner.resolveRef('main')
  return { cwd, runner, commit }
}

/** git outside the runner, so a test controls exactly which guard is present. */
async function rawGit(cwd: string, args: string[], env: Record<string, string>) {
  return run('git', args, {
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: cwd,
      GIT_SSL_CAINFO: process.env.GIT_SSL_CAINFO ?? '',
      GIT_TERMINAL_PROMPT: '0',
      ...env,
    },
  })
}

async function gitVersion(): Promise<[number, number]> {
  const { stdout } = await run('git', ['--version'])
  const [major, minor] = (stdout.match(/(\d+)\.(\d+)/) ?? ['', '0', '0']).slice(1).map(Number)
  return [major, minor]
}

test.group('history without contents', (group) => {
  group.setup(async () => {
    await startFixtureGitServer()
  })

  test('after the history fetch the object database holds only the indexed tree’s blobs, no promisor configuration remains, and every commit in the window is present', async ({
    assert,
  }) => {
    const repo = await historyRepo('clean')
    const { cwd, runner, commit } = await ingestHistory(repo.url)
    try {
      const outcome = await runner.fetchHistory(repo.url, 'main', commit, 500)
      assert.equal(outcome.commits, 4)

      const { stdout: all } = await rawGit(
        cwd,
        ['cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectname)'],
        { GIT_NO_LAZY_FETCH: '1' }
      )
      const blobs = all
        .split('\n')
        .filter((l) => l.startsWith('blob '))
        .map((l) => l.slice(5))
        .sort()
      const { stdout: tree } = await rawGit(cwd, ['ls-tree', '-r', commit], {
        GIT_NO_LAZY_FETCH: '1',
      })
      const treeBlobs = tree
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split(/\s+/)[2])
        .sort()
      assert.deepEqual(blobs, treeBlobs, 'no historical blob was fetched')

      const { stdout: config } = await rawGit(cwd, ['config', '--list', '--local'], {})
      assert.notMatch(config, /promisor|partialclone/i, config)

      const { stdout: log } = await rawGit(cwd, ['rev-list', '--count', commit], {
        GIT_NO_LAZY_FETCH: '1',
      })
      assert.equal(log.trim(), '4', 'the whole scripted history is in the window')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }).tags(['AC-WP03-05', 'wp03'])

  test('a historical secret cannot be read back: not with the promisor removed, not with the promisor present under GIT_NO_LAZY_FETCH, and the server sees no request; with both guards off it leaks (positive control)', async ({
    assert,
  }) => {
    const repo = await historyRepo('guards')
    const secretBlob = await fixtureBlobAt(repo, repo.commits[0], 's.env')
    const { cwd, runner, commit } = await ingestHistory(repo.url)
    try {
      await runner.fetchHistory(repo.url, 'main', commit, 500)
      const read = (env: Record<string, string>) =>
        rawGit(cwd, ['cat-file', '-p', secretBlob], env).then(
          (r) => ({ ok: true, out: r.stdout }),
          (e: { stdout?: string }) => ({ ok: false, out: String(e.stdout ?? '') })
        )

      // Control 1 alone: configuration removed, no environment guard.
      let mark = fixtureRequests().length
      let result = await read({})
      assert.isFalse(result.ok, 'promisor removed: the read fails')
      assert.notInclude(result.out, SECRET)
      assert.deepEqual(fixtureRequests().slice(mark), [], 'no request reached the server')

      // Restore the promisor configuration the fetch wrote, as a host or a later git might.
      await rawGit(cwd, ['config', `remote.${repo.url}.promisor`, 'true'], {})
      await rawGit(cwd, ['config', `remote.${repo.url}.partialclonefilter`, 'blob:none'], {})
      await rawGit(cwd, ['config', 'extensions.partialClone', repo.url], {})

      // Control 2 alone: promisor present, GIT_NO_LAZY_FETCH=1 (git ≥ 2.44).
      const [major, minor] = await gitVersion()
      if (major > 2 || (major === 2 && minor >= 44)) {
        mark = fixtureRequests().length
        result = await read({ GIT_NO_LAZY_FETCH: '1' })
        assert.isFalse(result.ok, 'GIT_NO_LAZY_FETCH: the read fails')
        assert.notInclude(result.out, SECRET)
        assert.deepEqual(fixtureRequests().slice(mark), [], 'no request reached the server')
      } else {
        console.warn(`GIT_NO_LAZY_FETCH half skipped: git ${major}.${minor} predates 2.44`)
      }

      // Positive control: both guards off — the leak's probe found.
      mark = fixtureRequests().length
      result = await read({})
      assert.isTrue(result.ok, 'with both guards off the blob is fetched on demand')
      assert.include(result.out, SECRET)
      assert.isNotEmpty(fixtureRequests().slice(mark), 'the lazy fetch reached the server')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }).tags(['AC-WP03-05', 'wp03'])

  test('a host that ignores the filter and sends historical blobs fails the step with COCHANGE_FILTER_REFUSED', async ({
    assert,
  }) => {
    const repo = await historyRepo('refused', false)
    const { cwd, runner, commit } = await ingestHistory(repo.url)
    try {
      const error = await runner.fetchHistory(repo.url, 'main', commit, 500).then(
        () => null,
        (e: unknown) => e
      )
      assert.instanceOf(error, HistoryFetchError)
      assert.equal((error as HistoryFetchError).code, 'COCHANGE_FILTER_REFUSED')
      // The message names counts, never a path or blob content.
      assert.notInclude((error as Error).message, SECRET)
      assert.notInclude((error as Error).message, 's.env')
      const { stdout: config } = await rawGit(cwd, ['config', '--list', '--local'], {})
      assert.notMatch(
        config,
        /promisor|partialclone/i,
        'the configuration is removed even on refusal'
      )
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }).tags(['AC-WP03-02', 'wp03'])

  test('an unreachable host is COCHANGE_GIT_FAILED and a slow one COCHANGE_TIMEOUT, each a coded error', async ({
    assert,
  }) => {
    const repo = await historyRepo('failures')
    const { cwd, commit } = await ingestHistory(repo.url)
    try {
      const failed = await new GitRunner({ cwd })
        .fetchHistory(repo.url.replace('/failures.git', '/missing.git'), 'main', commit, 500)
        .then(
          () => null,
          (e: unknown) => e
        )
      assert.equal((failed as HistoryFetchError).code, 'COCHANGE_GIT_FAILED')
      const slowUrl = repo.url.replace(FIXTURE_BASE, `${FIXTURE_BASE}/slow`)
      const slow = await new GitRunner({ cwd, timeoutMs: SLOW_MS / 3 })
        .fetchHistory(slowUrl, 'main', commit, 500)
        .then(
          () => null,
          (e: unknown) => e
        )
      assert.equal((slow as HistoryFetchError).code, 'COCHANGE_TIMEOUT')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }).tags(['AC-WP03-02', 'wp03'])
})
