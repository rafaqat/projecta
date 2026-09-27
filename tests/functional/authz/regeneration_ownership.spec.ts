import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import { claimRegeneration, InputRejectedError } from '#app/assistant/turn_service'
import { securityEvents } from '#app/security/events/index'
import type { SecurityEventRecord } from '#app/security/events/emitter'
import { inScope } from '#app/security/scope'
import { newHandle } from '#app/security/handles'
import { seedTwoWorkspaces, type SeededWorkspace } from '#tests/helpers/tenancy'
import { resetDatabase } from '#tests/helpers/db'

/**
 * A turn's one-shot regeneration is claimed by its opaque handle. The claim must belong to the turn's
 * OWNER (threads.user_id), not merely to any workspace member who can view the repository: row-level
 * security isolates the workspace, but threads are per-reader (normal history/lookup already filter
 * user_id), so regeneration by another member is an IDOR that exposes the owner's prior answer to the
 * attacker's continuation and mutates the owner's thread. The claim must also be atomic and one-shot.
 * (Adversarial finding P1, 2026-09-26.)
 */
async function seedOwnerTurn(
  ws: SeededWorkspace
): Promise<{ threadId: string; turnHandle: string }> {
  const commitId = randomUUID()
  const threadId = randomUUID()
  const turnHandle = newHandle()
  await inScope({ userId: ws.owner.id, workspaceId: ws.workspace.id }, async (trx) => {
    await trx.table('commits').insert({
      id: commitId,
      workspace_id: ws.workspace.id,
      repository_id: ws.open.id,
      sha: 'a'.repeat(40),
      status: 'indexed',
      created_at: new Date(),
    })
    await trx.from('repositories').where('id', ws.open.id).update({ active_commit_id: commitId })
    await trx.table('threads').insert({
      id: threadId,
      handle: newHandle(),
      workspace_id: ws.workspace.id,
      repository_id: ws.open.id,
      user_id: ws.owner.id,
      created_at: new Date(),
    })
    await trx.table('turns').insert({
      id: randomUUID(),
      thread_id: threadId,
      workspace_id: ws.workspace.id,
      run_handle: turnHandle,
      commit_id: commitId,
      question: 'owner-only question',
      answer_text: 'OWNER ONLY',
      run_state: 'completed',
      created_at: new Date(),
    })
  })
  return { threadId, turnHandle }
}

test.group('regeneration ownership', (group) => {
  group.each.setup(() => resetDatabase())

  test('a same-workspace member cannot regenerate another member’s turn, and it is observable', async ({
    assert,
  }) => {
    const { a } = await seedTwoWorkspaces()
    const { turnHandle } = await seedOwnerTurn(a)
    const seen: SecurityEventRecord[] = []
    const off = securityEvents.tap((r) => seen.push(r))
    try {
      await assert.rejects(
        () =>
          claimRegeneration(
            { userId: a.member.id, workspaceId: a.workspace.id },
            a.open.id,
            turnHandle,
            'req-idor'
          ),
        InputRejectedError
      )
    } finally {
      off()
    }
    // The IDOR attempt is surfaced to observability (log + counter), not silently rejected.
    const denied = seen.find(
      (r) => r.event === 'authz.denied' && r.fields.policy === 'turn.regenerate'
    )
    assert.exists(denied, 'a cross-user regeneration attempt emits authz.denied')
  }).tags(['wp02', 'sec-regeneration-ownership'])

  test('the turn owner can regenerate once, and only once', async ({ assert }) => {
    const { a } = await seedTwoWorkspaces()
    const { threadId, turnHandle } = await seedOwnerTurn(a)
    const owner = { userId: a.owner.id, workspaceId: a.workspace.id }
    const claimed = await claimRegeneration(owner, a.open.id, turnHandle)
    assert.equal(claimed.id, threadId)
    await assert.rejects(() => claimRegeneration(owner, a.open.id, turnHandle), InputRejectedError)
  }).tags(['wp02', 'sec-regeneration-ownership'])

  test('a member in another workspace cannot regenerate the turn', async ({ assert }) => {
    const { a, b } = await seedTwoWorkspaces()
    const { turnHandle } = await seedOwnerTurn(a)
    await assert.rejects(
      () =>
        claimRegeneration(
          { userId: b.owner.id, workspaceId: b.workspace.id },
          a.open.id,
          turnHandle
        ),
      InputRejectedError
    )
  }).tags(['wp02', 'sec-regeneration-ownership'])
})
