import { execFile, spawn } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

/**
 * Smart-HTTP git server for deployment conformance (WP-17), test profile
 * only. At start it builds the shop fixture into a bare repository and
 * issues a self-signed certificate for its own service name, written to
 * CA_DIR so the worker can trust it through GIT_SSL_CAINFO. Serves
 * `git http-backend` over TLS on PORT; nothing else.
 */
const run = promisify(execFile)
const PORT = Number(process.env.PORT ?? 8443)
const HOST = process.env.SERVICE_HOST ?? 'git-fixture'
const CA_DIR = process.env.CA_DIR ?? '/fixture-ca'
const FIXTURE = process.env.FIXTURE_DIR ?? '/app/fixtures/node-express-shop'
const ROOT = process.env.REPO_ROOT ?? '/tmp/repos'

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd })
  return stdout.trim()
}

async function buildRepo(owner: string, name: string): Promise<string> {
  const work = join('/tmp/work', owner, name)
  await mkdir(work, { recursive: true })
  await git(work, 'init', '-q', '-b', 'main')
  for (const entry of await readdir(FIXTURE, { recursive: true })) {
    if (entry.startsWith('symbols')) continue
    const content = await readFile(join(FIXTURE, entry)).catch(() => null)
    if (content === null) continue
    await mkdir(dirname(join(work, entry)), { recursive: true })
    await writeFile(join(work, entry), content)
  }
  await git(work, 'add', '-A')
  await git(
    work,
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-q',
    '-m',
    'fixture'
  )
  const bare = join(ROOT, owner, `${name}.git`)
  await mkdir(dirname(bare), { recursive: true })
  await git('/tmp', 'clone', '-q', '--bare', work, bare)
  // Like GitHub: partial-clone filters and any reachable object by SHA, so the worker's
  // history fetch runs against the same host behaviour it meets in production.
  await git(bare, 'config', 'uploadpack.allowFilter', 'true')
  await git(bare, 'config', 'uploadpack.allowReachableSHA1InWant', 'true')
  return git(work, 'rev-parse', 'HEAD')
}

async function certificate(): Promise<{ key: Buffer; cert: Buffer }> {
  await mkdir(CA_DIR, { recursive: true })
  const keyPath = join('/tmp', 'key.pem')
  const certPath = join(CA_DIR, 'cert.pem')
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '2',
    '-subj',
    `/CN=${HOST}`,
    '-addext',
    `subjectAltName=DNS:${HOST}`,
  ])
  return { key: await readFile(keyPath), cert: await readFile(certPath) }
}

const sha = await buildRepo('fixtures', 'shop')
const { key, cert } = await certificate()
const server = createServer({ key, cert }, (req, res) => {
  const url = new URL(req.url ?? '/', `https://${HOST}:${PORT}`)
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ status: 'ok', sha }))
  }
  const cgi = spawn('git', ['http-backend'], {
    env: {
      PATH: process.env.PATH ?? '',
      GIT_PROJECT_ROOT: ROOT,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method ?? 'GET',
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      REMOTE_ADDR: req.socket.remoteAddress ?? '',
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
server.listen(PORT, '0.0.0.0', () =>
  console.log(JSON.stringify({ level: 'info', msg: 'git-fixture listening', port: PORT, sha }))
)
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => server.close(() => process.exit(0)))
