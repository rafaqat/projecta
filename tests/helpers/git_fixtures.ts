import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, symlink, readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const FIXTURE_HOST = 'localhost'
export const FIXTURE_PORT = 8443
export const FIXTURE_BASE = `https://${FIXTURE_HOST}:${FIXTURE_PORT}`
/** How long a `/slow/` request waits before it is served. */
export const SLOW_MS = 3000

export type FixtureEntry = string | Buffer | { symlink: string } | { gitlink: string }

export interface FixtureRepo {
  url: string
  workTree: string
  bare: string
  headSha: string
}

let root: string | undefined
let server: Server | undefined
let caPath: string | undefined
/** Every request the fixture server answered, as `METHOD path?query`, in order. */
const requests: string[] = []

/** What the fixture server has been asked since it started; a test takes a mark and compares. */
export function fixtureRequests(): readonly string[] {
  return requests
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'f@x.test',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'f@x.test',
      // Fixed dates make fixture commit SHAs reproducible, so golden sets can pin them.
      GIT_AUTHOR_DATE: '2026-09-11T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-09-11T00:00:00Z',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: cwd,
    },
  })
  return stdout.trim()
}

async function fixtureRoot(): Promise<string> {
  root ??= await mkdtemp(join(tmpdir(), 'git-fixtures-'))
  return root
}

/** Creates a working repository, commits the entries, and publishes a bare mirror. */
export async function buildFixtureRepo(
  owner: string,
  name: string,
  entries: Record<string, FixtureEntry>
): Promise<FixtureRepo> {
  const base = await fixtureRoot()
  const workTree = join(base, 'work', owner, name)
  await mkdir(workTree, { recursive: true })
  await git(workTree, 'init', '-q', '-b', 'main')
  await writeEntries(workTree, entries)
  await git(workTree, 'commit', '-q', '-m', 'fixture')
  const headSha = await git(workTree, 'rev-parse', 'HEAD')
  const bare = join(base, 'repos', owner, `${name}.git`)
  await mkdir(dirname(bare), { recursive: true })
  await git(base, 'clone', '-q', '--bare', workTree, bare)
  // As GitHub does: a commit reachable from a ref may be fetched by id, which is how a pinned
  // commit is ingested. Without it a pin the branch has moved past is refused.
  await git(bare, 'config', 'uploadpack.allowReachableSHA1InWant', 'true')
  return { url: `${FIXTURE_BASE}/${owner}/${name}.git`, workTree, bare, headSha }
}

export interface FixtureCommit {
  /** Files written (or overwritten) and staged. */
  entries?: Record<string, FixtureEntry>
  /** Paths removed in this commit. */
  remove?: string[]
  message?: string
  author?: { name: string; email: string }
  /** Commits made on a side branch from here, then merged with `--no-ff` (the merge is this commit). */
  merge?: FixtureCommit[]
}

/**
 * A fixture with a scripted history: each commit in order, then a bare mirror. The
 * bare repository allows partial-clone filters only when asked, so a host that ignores the
 * filter can be served too. Returns every commit SHA, oldest first.
 */
export async function buildFixtureHistory(
  owner: string,
  name: string,
  commits: FixtureCommit[],
  options: { allowFilter: boolean } = { allowFilter: true }
): Promise<FixtureRepo & { commits: string[] }> {
  const base = await fixtureRoot()
  const workTree = join(base, 'work', owner, name)
  await mkdir(workTree, { recursive: true })
  await git(workTree, 'init', '-q', '-b', 'main')
  const shas: string[] = []
  for (const [i, commit] of commits.entries()) {
    if (commit.merge) {
      const branch = `side-${i}`
      await git(workTree, 'checkout', '-q', '-b', branch)
      for (const [j, side] of commit.merge.entries()) {
        if (side.entries) await writeEntries(workTree, side.entries)
        for (const path of side.remove ?? []) await git(workTree, 'rm', '-q', '--', path)
        await git(
          workTree,
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          side.message ?? `side ${i}.${j + 1}`
        )
      }
      await git(workTree, 'checkout', '-q', 'main')
      await git(
        workTree,
        'merge',
        '-q',
        '--no-ff',
        '-m',
        commit.message ?? `merge ${i + 1}`,
        branch
      )
      shas.push(await git(workTree, 'rev-parse', 'HEAD'))
      continue
    }
    if (commit.entries) await writeEntries(workTree, commit.entries)
    for (const path of commit.remove ?? []) await git(workTree, 'rm', '-q', '--', path)
    await git(
      workTree,
      'commit',
      '-q',
      '--allow-empty',
      ...(commit.author ? ['--author', `${commit.author.name} <${commit.author.email}>`] : []),
      '-m',
      commit.message ?? `commit ${i + 1}`
    )
    shas.push(await git(workTree, 'rev-parse', 'HEAD'))
  }
  const bare = join(base, 'repos', owner, `${name}.git`)
  await mkdir(dirname(bare), { recursive: true })
  await git(base, 'clone', '-q', '--bare', workTree, bare)
  await git(bare, 'config', 'uploadpack.allowFilter', String(options.allowFilter))
  // Like GitHub: any object reachable from a ref can be asked for by SHA. Without it a lazy fetch
  // of a historical blob is refused by the server, and a test of the client's guards would pass
  // for the wrong reason.
  await git(bare, 'config', 'uploadpack.allowReachableSHA1InWant', 'true')
  return {
    url: `${FIXTURE_BASE}/${owner}/${name}.git`,
    workTree,
    bare,
    headSha: shas[shas.length - 1],
    commits: shas,
  }
}

/** The blob SHA a path had at a commit of a fixture's working repository. */
export async function fixtureBlobAt(repo: FixtureRepo, commit: string, path: string) {
  return git(repo.workTree, 'rev-parse', `${commit}:${path}`)
}

/** Adds a second commit to a fixture and republishes it. */
export async function commitFixtureChanges(
  repo: FixtureRepo,
  entries: Record<string, FixtureEntry>,
  message = 'second'
): Promise<string> {
  await writeEntries(repo.workTree, entries)
  await git(repo.workTree, 'commit', '-q', '-m', message)
  await git(repo.workTree, 'push', '-q', repo.bare, 'main')
  return git(repo.workTree, 'rev-parse', 'HEAD')
}

/** Writes and stages entries; gitlinks are staged after `add -A` so the add does not unstage them. */
async function writeEntries(
  workTree: string,
  entries: Record<string, FixtureEntry>
): Promise<void> {
  const gitlinks: Array<[string, string]> = []
  for (const [path, entry] of Object.entries(entries)) {
    const full = join(workTree, path)
    await mkdir(dirname(full), { recursive: true })
    if (typeof entry === 'string' || Buffer.isBuffer(entry)) await writeFile(full, entry)
    else if ('symlink' in entry) await symlink(entry.symlink, full)
    else gitlinks.push([path, entry.gitlink])
  }
  await git(workTree, 'add', '-A')
  for (const [path, sha] of gitlinks) {
    await git(workTree, 'update-index', '--add', '--cacheinfo', `160000,${sha},${path}`)
  }
}

/**
 * Smart-HTTP git server over TLS with a self-signed certificate, backed by
 * `git http-backend`. Paths under /redirect/ answer 302 to exercise the
 * no-redirect policy.
 */
export async function startFixtureGitServer(): Promise<{ caPath: string }> {
  if (server) return { caPath: caPath! }
  const base = await fixtureRoot()
  const keyPath = join(base, 'key.pem')
  caPath = join(base, 'cert.pem')
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    caPath,
    '-days',
    '2',
    '-subj',
    `/CN=${FIXTURE_HOST}`,
    '-addext',
    `subjectAltName=DNS:${FIXTURE_HOST}`,
  ])
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(caPath)])
  const projectRoot = join(base, 'repos')

  server = createServer({ key, cert }, (req, res) => {
    const url = new URL(req.url ?? '/', FIXTURE_BASE)
    requests.push(`${req.method ?? 'GET'} ${url.pathname}${url.search}`)
    // `/slow/<path>` answers like `<path>` after SLOW_MS: a host a timeout must cut off.
    if (url.pathname.startsWith('/slow/')) {
      const target = `${url.pathname.slice('/slow'.length)}${url.search}`
      setTimeout(() => {
        req.url = target
        server!.emit('request', req, res)
      }, SLOW_MS)
      return
    }
    if (url.pathname.startsWith('/redirect/')) {
      res.writeHead(302, {
        location: `${FIXTURE_BASE}/${url.pathname.slice('/redirect/'.length)}${url.search}`,
      })
      return res.end()
    }
    const cgi = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH ?? '',
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_ADDR: '127.0.0.1',
      },
    })
    req.pipe(cgi.stdin)
    let head = Buffer.alloc(0)
    let headersDone = false
    cgi.stdout.on('data', (chunk: Buffer) => {
      if (headersDone) return void res.write(chunk)
      head = Buffer.concat([head, chunk])
      const split = head.indexOf('\r\n\r\n')
      if (split === -1) return
      const headers: Record<string, string> = {}
      let status = 200
      for (const line of head.subarray(0, split).toString().split('\r\n')) {
        const [name, ...rest] = line.split(':')
        if (name.toLowerCase() === 'status') status = Number(rest.join(':').trim().split(' ')[0])
        else if (name) headers[name.trim()] = rest.join(':').trim()
      }
      res.writeHead(status, headers)
      headersDone = true
      res.write(head.subarray(split + 4))
    })
    cgi.on('close', () => res.end())
  })
  await new Promise<void>((resolve) => server!.listen(FIXTURE_PORT, '127.0.0.1', resolve))
  server.unref()
  process.env.GIT_SSL_CAINFO = caPath
  return { caPath }
}
