import { test } from '@japa/runner'
import { exclusionsFor } from '#app/retrieval/exclusions'
import { securityEvents } from '#app/security/events/index'
import type { SecurityEventRecord } from '#app/security/events/emitter'
import { inScope } from '#app/security/scope'
import { startFixtureGitServer } from '#tests/helpers/git_fixtures'
import {
  indexFixture,
  scopeOf,
  shopEntries,
  type IndexedFixture,
} from '#tests/helpers/shop_fixture'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'
import { resetDatabase } from '#tests/helpers/db'

/**
 * Repository content that carries the active system-prompt canary or a
 * planted honeytoken value is excluded at index time with a coded event
 * (WP-19, BL-05). Otherwise every answer citing it would trip the gateway's
 * canary or honeytoken rule and be held, with nothing naming the cause.
 */
const CANARY = 'CANARY-COLLISION-5d1e'
let a: SeededWorkspace
let seeded: IndexedFixture
let before: string | undefined

test.group('canary and honeytoken collision at ingest (WP-19, BL-05)', (group) => {
  group.setup(async () => {
    before = process.env.SYSTEM_PROMPT_CANARY
    process.env.SYSTEM_PROMPT_CANARY = CANARY
    await startFixtureGitServer()
    await resetDatabase()
    ;({ a } = await seedTwoWorkspaces())
    seeded = await indexFixture(a, 'shop-canary-seed', await shopEntries(), 'shop')
  })
  group.teardown(() => {
    if (before === undefined) delete process.env.SYSTEM_PROMPT_CANARY
    else process.env.SYSTEM_PROMPT_CANARY = before
  })

  test('a file carrying the canary or the workspace honeytoken is excluded with a reason and reported once each', async ({
    assert,
  }) => {
    const planted = await inScope(scopeOf(a), (trx) =>
      trx.from('honeytokens').where('workspace_id', a.workspace.id).first()
    )
    assert.exists(planted, 'the first ingest planted a honeytoken')
    const events: SecurityEventRecord[] = []
    const untap = securityEvents.tap((e) => {
      events.push(e)
    })
    let fixture: IndexedFixture
    try {
      fixture = await indexFixture(
        a,
        'shop-canary-collision',
        {
          ...(await shopEntries()),
          'src/config/prompt.ts': `export const SYSTEM = 'answer only from records ${CANARY}'\n`,
          'src/config/partner.ts': `export const apiToken = '${planted.token}'\n`,
        },
        'shop'
      )
    } finally {
      untap()
    }
    assert.notEqual(fixture.commitId, seeded.commitId)
    const exclusions = await exclusionsFor(scopeOf(a), fixture.commitId)
    assert.deepInclude(exclusions, { path: 'src/config/prompt.ts', reason: 'canary_collision' })
    assert.deepInclude(exclusions, { path: 'src/config/partner.ts', reason: 'canary_collision' })
    const rejected = events.filter(
      (e) => e.event === 'ingest.rejected' && e.fields.reason === 'canary_collision'
    )
    assert.lengthOf(rejected, 2, 'one coded event per colliding file')
    const chunks = await inScope(scopeOf(a), (trx) =>
      trx
        .from('chunks')
        .where('commit_id', fixture.commitId)
        .whereIn('path', ['src/config/prompt.ts', 'src/config/partner.ts'])
    )
    assert.lengthOf(chunks, 0, 'nothing of either file reaches the index')
  }).tags(['AC-WP19-09', 'wp19'])
})
