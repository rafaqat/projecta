import { test } from '@japa/runner'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import db from '@adonisjs/lucid/services/db'
import pg from 'pg'
import { FrameDecoder, type AnswerEvent } from '#app/assistant/protocol'
import { loadSmokeSet } from '#app/assistant/smoke'
import { newHandle } from '#app/security/handles'
import { inScope } from '#app/security/scope'

/**
 * Deployment conformance (WP-17): the smoke set asked through the built
 * `web` and `llm-gateway` images via the ingress, with the scripted
 * provider stub as upstream. Every seam that has broken before is crossed
 * here: source→image, host hash→container hash, SDK→gateway,
 * provider→gateway. Run with `make conformance`.
 */
const run = promisify(execFile)
const BASE = process.env.CONFORMANCE_BASE_URL ?? 'http://localhost:3333'
const ISSUER_HOST = process.env.CONFORMANCE_ISSUER_HOST ?? '127.0.0.1:9000'
const GATEWAY_DB =
  process.env.CONFORMANCE_GATEWAY_DATABASE_URL ?? 'postgres://gateway:gateway@127.0.0.1:5433/app'
/** The mock provider's default profile (services/mock-oidc/src/server.ts); accounts are keyed by (tid, oid). */
const DEVELOPER = {
  tid: 'tenant-local',
  oid: process.env.CONFORMANCE_USER_OID ?? 'local-developer',
}
const COMPOSE = [
  'compose',
  '--env-file',
  '.env',
  '-f',
  'docker/compose.yml',
  '-f',
  'docker/compose.conformance.yml',
  '--profile',
  'test',
]
const FIXTURE_URL =
  process.env.CONFORMANCE_FIXTURE_URL ?? 'https://git-fixture:8443/fixtures/shop.git'
const INDEX_TIMEOUT_MS = 180_000

/** A minimal cookie jar: the ingress sets several cookies across the sign-in redirects. */
class Jar {
  private cookies = new Map<string, string>()
  absorb(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';')
      const at = pair.indexOf('=')
      this.cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }
  get(name: string): string {
    return decodeURIComponent(this.cookies.get(name) ?? '')
  }
}

/** Signs in through the stack's mock provider: app → provider → app. */
async function signIn(): Promise<Jar> {
  const jar = new Jar()
  const start = await fetch(`${BASE}/auth/login`, { redirect: 'manual' })
  jar.absorb(start)
  const authorize = new URL(start.headers.get('location')!)
  authorize.host = ISSUER_HOST
  const atProvider = await fetch(authorize, { redirect: 'manual' })
  const back = new URL(atProvider.headers.get('location')!)
  back.host = new URL(BASE).host
  const callback = await fetch(back, { redirect: 'manual', headers: { cookie: jar.header() } })
  jar.absorb(callback)
  if (callback.status !== 302) throw new Error(`sign-in callback answered ${callback.status}`)
  return jar
}

interface Seeded {
  workspace: string
  repository: string
  commitSha: string
}

/** A workspace for the signed-in user; the repository is registered through the API and indexed by the worker image. */
async function seed(jar: Jar): Promise<Seeded> {
  const user = await db.from('users').where(DEVELOPER).first()
  if (!user) throw new Error(`no user for ${DEVELOPER.oid}; sign-in must run first`)
  const workspace = { id: randomUUID(), handle: newHandle() }
  await inScope({ userId: user.id }, async (trx) => {
    await trx
      .table('workspaces')
      .insert({ ...workspace, name: 'Conformance', created_at: new Date() })
    await trx.table('workspace_memberships').insert({
      workspace_id: workspace.id,
      user_id: user.id,
      role: 'owner',
      created_at: new Date(),
    })
  })
  const registered = await fetch(`${BASE}/w/${workspace.handle}/repos`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json',
      'cookie': jar.header(),
      'x-xsrf-token': jar.get('XSRF-TOKEN'),
    },
    body: JSON.stringify({ url: FIXTURE_URL, name: 'shop' }),
  })
  if (registered.status !== 201)
    throw new Error(`registration answered ${registered.status}: ${await registered.text()}`)
  const { handle } = (await registered.json()) as { handle: string }
  const seeded = { workspace: workspace.handle, repository: handle, commitSha: '' }
  // The worker image fetches from the fixture service and indexes; the scope endpoint reports the commit once done.
  const deadline = Date.now() + INDEX_TIMEOUT_MS
  while (Date.now() < deadline) {
    const scope = await fetch(`${BASE}/api/w/${seeded.workspace}/r/${handle}/scope`, {
      headers: { accept: 'application/json', cookie: jar.header() },
    })
    if (scope.status === 200) {
      const { commitSha } = (await scope.json()) as { commitSha: string | null }
      if (commitSha) return { ...seeded, commitSha }
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`the worker did not index ${FIXTURE_URL} within ${INDEX_TIMEOUT_MS / 1000}s`)
}

async function ask(jar: Jar, seeded: Seeded, question: string): Promise<AnswerEvent[]> {
  const response = await fetch(`${BASE}/api/w/${seeded.workspace}/r/${seeded.repository}/turns`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      'cookie': jar.header(),
      'x-xsrf-token': jar.get('XSRF-TOKEN'),
    },
    body: JSON.stringify({ question }),
  })
  if (response.status !== 200) throw new Error(`turn answered ${response.status}`)
  return new FrameDecoder().push(await response.text())
}

async function decision(jar: Jar, seeded: Seeded, runId: string) {
  const response = await fetch(
    `${BASE}/api/w/${seeded.workspace}/r/${seeded.repository}/turns/${runId}/decision`,
    { headers: { accept: 'application/json', cookie: jar.header() } }
  )
  return { status: response.status, body: (await response.json()) as { record: unknown } }
}

async function gatewayRowsSince(since: Date) {
  const client = new pg.Client({ connectionString: GATEWAY_DB, connectionTimeoutMillis: 5000 })
  await client.connect()
  try {
    const { rows } = await client.query<{ status: string; purpose: string; rule: string | null }>(
      'select status, purpose, rule from gateway.ledger where started_at >= $1 order by started_at',
      [since]
    )
    return rows
  } finally {
    await client.end()
  }
}

async function containerLogs(service: string, since: Date): Promise<string> {
  const { stdout, stderr } = await run('docker', [
    'logs',
    `cia-${service}-1`,
    '--since',
    since.toISOString(),
  ])
  return stdout + stderr
}

async function imageDigest(service: string): Promise<string> {
  const { stdout } = await run('docker', ['inspect', `cia-${service}-1`, '--format', '{{.Image}}'])
  return stdout.trim()
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

const runStateOf = (events: AnswerEvent[]) =>
  (events.filter((e) => e.type === 'status').at(-1) as { runState: string; runId: string }) ?? {}

let jar: Jar
let seeded: Seeded
const started = new Date()
const record: {
  environment: Record<string, string>
  at: string
  turns: Array<{ question: string; runState: string; citations: number; verified: number }>
} = { environment: {}, at: started.toISOString(), turns: [] }

test.group('deployment conformance (WP-17)', (group) => {
  group.setup(async () => {
    record.environment = {
      'web': `image:${await imageDigest('web')}`,
      'llm-gateway': `image:${await imageDigest('llm-gateway')}`,
    }
    jar = await signIn()
    seeded = await seed(jar)
  })
  group.teardown(async () => {
    await mkdir('tmp/evals', { recursive: true })
    await writeFile('tmp/evals/deployment-conformance.json', JSON.stringify(record, null, 2) + '\n')
  })

  test('a repository registered through the API is fetched from the fixture service and indexed by the worker image', async ({
    assert,
  }) => {
    assert.match(seeded.commitSha, /^[0-9a-f]{40}$/)
    const logs = await containerLogs('worker', started)
    assert.notInclude(logs, 'error.unhandled')
    assert.notInclude(logs, 'ingest.rejected')
  }).tags(['AC-WP17-05', 'wp17'])

  test('every smoke-set question completes through the images with a verified citation, a decision record and a completed gateway call', async ({
    assert,
  }) => {
    const set = await loadSmokeSet()
    const since = new Date()
    for (const question of set.questions) {
      const events = await ask(jar, seeded, question)
      const { runState, runId } = runStateOf(events)
      const citations = events.filter(
        (e): e is Extract<AnswerEvent, { type: 'citation' }> => e.type === 'citation'
      )
      const verified = citations.filter((c) => sha256(c.snippet) === c.spanSha256)
      record.turns.push({
        question,
        runState,
        citations: citations.length,
        verified: verified.length,
      })
      assert.equal(runState, 'completed', question)
      assert.isAtLeast(verified.length, 1, `${question}: a citation whose span hash verifies`)
      const { status, body } = await decision(jar, seeded, runId)
      assert.equal(status, 200, question)
      assert.exists(body.record, `${question}: decision record`)
    }
    const rows = await gatewayRowsSince(since)
    assert.isAtLeast(rows.length, set.questions.length, 'one gateway call per question at least')
    assert.deepEqual(
      rows.filter((r) => r.status !== 'completed'),
      [],
      'every gateway call completed'
    )
    for (const service of ['web', 'llm-gateway']) {
      assert.notInclude(await containerLogs(service, since), 'error.unhandled', service)
    }
  }).tags(['AC-WP17-01', 'AC-WP17-03', 'wp17'])

  test('a question the rules cannot decide reaches the classifier through the gateway allowlists', async ({
    assert,
  }) => {
    const since = new Date()
    const events = await ask(jar, seeded, 'Can you walk me through how all of this fits together?')
    assert.include(['completed'], runStateOf(events).runState)
    const rows = await gatewayRowsSince(since)
    const classified = rows.filter((r) => r.purpose === 'scope_classification')
    assert.isAtLeast(classified.length, 1, 'the classifier was called')
    assert.deepEqual(
      classified.map((r) => r.status),
      classified.map(() => 'completed')
    )
  }).tags(['AC-WP17-02', 'wp17'])

  test('a provider failure mid-stream ends the turn as failed and is reported once, with a code and a hash, never a message', async ({
    assert,
  }) => {
    const stub = (failEvery: string) =>
      run('docker', [...COMPOSE, 'up', '-d', '--no-deps', '--wait', 'provider-stub'], {
        env: { ...process.env, PROVIDER_STUB_FAIL_EVERY: failEvery },
      })
    await stub('1')
    const since = new Date()
    try {
      const events = await ask(jar, seeded, 'How is a refund processed?')
      assert.equal(runStateOf(events).runState, 'failed')
      const logs = await containerLogs('web', since)
      const reports = logs.split('\n').filter((l) => l.includes('"error.unhandled"'))
      assert.lengthOf(reports, 1, 'exactly one report')
      assert.match(reports[0], /"errorCode":"[A-Za-z_]+"/)
      assert.match(reports[0], /"errorHash":"[0-9a-f]{16}"/)
      assert.notInclude(reports[0], '"message"')
    } finally {
      await stub('0')
    }
  }).tags(['AC-WP17-03', 'wp17'])

  test('the run record names the images it ran against', ({ assert }) => {
    assert.match(record.environment.web, /^image:sha256:[0-9a-f]{64}$/)
    assert.match(record.environment['llm-gateway'], /^image:sha256:[0-9a-f]{64}$/)
  }).tags(['AC-WP17-04', 'wp17'])
})
