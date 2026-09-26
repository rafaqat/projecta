import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import db from '@adonisjs/lucid/services/db'
import { type Indexer } from '#app/ingest/indexer'
import { DEFAULT_LIMITS } from '#app/ingest/limits'
import { IngestPipeline } from '#app/ingest/pipeline'
import { newHandle } from '#app/security/handles'
import { inScope, type Scope } from '#app/security/scope'
import {
  buildFixtureRepo,
  startFixtureGitServer,
  type FixtureEntry,
} from '#tests/helpers/git_fixtures'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'
import { resetDatabase } from '#tests/helpers/db'

/** The node-express-shop fixture, indexed into a seeded workspace. */
export const SHOP_FIXTURE = 'evals/fixtures/node-express-shop'

export interface IndexedFixture {
  repositoryId: string
  repositoryHandle: string
  commitId: string
  commitSha: string
  /** What the index step counted: files parsed and skipped, chunks, embeddings. */
  outcome: {
    filesParsed: number
    filesSkipped: Record<string, number>
    chunks: number
    dependencies: number
  }
}

export const scopeOf = (ws: SeededWorkspace): Scope => ({
  userId: ws.owner.id,
  workspaceId: ws.workspace.id,
})

/** Golden oracles kept beside a fixture (`symbols.manifest.json`, `references.manifest.json`) are never part of its repository. */
const ORACLE = /(^|\/)[\w-]+\.manifest\.json$/

/** A fixture directory's files as repository entries, oracles left out. */
export async function fixtureEntries(dir: string): Promise<Record<string, FixtureEntry>> {
  const entries: Record<string, FixtureEntry> = {}
  for (const entry of await readdir(dir, { recursive: true })) {
    if (ORACLE.test(entry)) continue
    const content = await readFile(join(dir, entry), 'utf8').catch(() => null)
    if (content !== null) entries[entry] = content
  }
  return entries
}

export async function shopEntries(): Promise<Record<string, FixtureEntry>> {
  return fixtureEntries(SHOP_FIXTURE)
}

export async function indexShop(
  ws: SeededWorkspace,
  name: string,
  extra: Record<string, FixtureEntry> = {}
): Promise<IndexedFixture> {
  // `extra` overlays test-only files (e.g. a planted injection for the flagged-chunk UI) onto the
  // in-memory entries; the on-disk golden fixture and its line-based manifests are never touched.
  return indexFixture(ws, name, { ...(await shopEntries()), ...extra }, 'shop')
}

/** Any fixture as a registered, indexed repository of the workspace. */
export async function indexFixture(
  ws: SeededWorkspace,
  name: string,
  entries: Record<string, FixtureEntry>,
  repositoryName: string,
  indexer?: Indexer
): Promise<IndexedFixture> {
  const repo = await buildFixtureRepo('fixtures', name, entries)
  const id = randomUUID()
  const handle = newHandle()
  await inScope(scopeOf(ws), (trx) =>
    trx.table('repositories').insert({
      id,
      handle,
      workspace_id: ws.workspace.id,
      name: repositoryName,
      url: repo.url,
      visibility: 'workspace',
      default_ref: 'main',
      created_at: new Date(),
    })
  )
  const outcome = await new IngestPipeline(DEFAULT_LIMITS, indexer).run({
    workspaceId: ws.workspace.id,
    repositoryId: id,
    actorUserId: ws.owner.id,
  })
  return {
    repositoryId: id,
    repositoryHandle: handle,
    commitId: outcome.commitId,
    commitSha: outcome.commitSha,
    outcome: {
      filesParsed: outcome.index?.filesParsed ?? 0,
      filesSkipped: outcome.index?.filesSkipped ?? {},
      chunks: outcome.index?.chunks ?? 0,
      dependencies: outcome.index?.dependencies ?? 0,
    },
  }
}

/** Fresh database, two workspaces, the shop indexed into workspace a. */
export async function freshShop(name: string, extra: Record<string, FixtureEntry> = {}) {
  await startFixtureGitServer()
  await resetDatabase()
  await db.from('honeytokens').delete()
  const { a, b } = await seedTwoWorkspaces()
  const fixture = await indexShop(a, name, extra)
  return { a, b, fixture }
}
