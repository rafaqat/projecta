import { Readable } from 'node:stream'
import type { HttpContext } from '@adonisjs/core/http'
import { AnswerEventEncoder } from '#app/assistant/sse'
import { answerTurn, checkInput, InputRejectedError } from '#app/assistant/turn_service'
import type { AnswerEvent } from '#app/assistant/protocol'
import { scopePolicy } from '#app/retrieval/router'
import { loadVocabulary, suggestedQuestions, suggestionsFromPaste } from '#app/retrieval/vocabulary'
import { inScope } from '#app/security/scope'
import { estimateNextTurn, turnCosts } from '#app/cost/turn_cost'
import { eraseTurn } from '#app/audit/decision_record'
import { turnValidator } from '#validators/turn'
import { assetsVersion } from '#app/assets_version'

const REJECTIONS: Record<InputRejectedError['reason'], string> = {
  too_long:
    'Questions are limited to {cap} characters. To compare code, use "find similar" on a citation.',
  attachment: 'Attachments are not accepted. To compare code, use "find similar" on a citation.',
  empty: 'Ask a question about the repository.',
  regenerated: 'This turn has already been regenerated once.',
}

export default class TurnsController {
  /** Query-box data: the scope pill and deterministic suggested questions (layer 1). */
  async scope({ auth, scope }: HttpContext) {
    const user = auth.getUserOrFail()
    const repository = scope.repository!
    if (!repository.activeCommitId)
      return { commitSha: null, suggestedQuestions: [], inputCap: scopePolicy().inputCapCharacters }
    const actor = { userId: user.id, workspaceId: scope.workspace.id }
    const commit = await inScope(actor, (trx) =>
      trx.from('commits').where('id', repository.activeCommitId!).first()
    )
    const vocabulary = await loadVocabulary(actor, repository.activeCommitId)
    return {
      commitSha: commit.sha,
      suggestedQuestions: suggestedQuestions(vocabulary),
      inputCap: scopePolicy().inputCapCharacters,
      // What the next question is likely to cost: the reader's recent turns, or the budgets.
      estimate: await estimateNextTurn(actor),
    }
  }

  /**
   * The reader's thread for this repository (: one per reader and
   * repository, prior answer text only): its turns in order, each with its
   * citations and its cost from the ledger. Erased turns are not shown; a
   * thread with none left is not continued.
   */
  async history({ auth, scope }: HttpContext) {
    const user = auth.getUserOrFail()
    const repository = scope.repository!
    const actor = { userId: user.id, workspaceId: scope.workspace.id }
    const thread = await inScope(actor, (trx) =>
      trx
        .from('threads')
        .where({ repository_id: repository.id, user_id: user.id })
        .orderBy('created_at', 'desc')
        .first()
    )
    if (!thread) return { threadHandle: null, turns: [] }
    const turns = await inScope(actor, (trx) =>
      trx
        .from('turns')
        .where('thread_id', thread.id)
        .whereNull('erased_at')
        .orderBy('created_at')
        .select('id', 'run_handle', 'question', 'answer_text', 'events', 'run_state', 'created_at')
    )
    if (turns.length === 0) return { threadHandle: null, turns: [] }
    const citations = await inScope(actor, (trx) =>
      trx
        .from('turn_citations')
        .whereIn(
          'turn_id',
          turns.map((t) => t.id)
        )
        .select('turn_id', 'handle', 'path', 'start_line', 'end_line')
        .orderBy(['turn_id', 'start_line'])
    )
    const costs = await turnCosts(
      actor,
      turns.map((t) => String(t.run_handle))
    )
    return {
      threadHandle: thread.handle,
      turns: turns.map((t) => ({
        runHandle: t.run_handle,
        question: t.question,
        answerText: t.answer_text,
        events: t.events ?? null,
        runState: t.run_state,
        createdAt: t.created_at,
        citations: citations
          .filter((c) => c.turn_id === t.id)
          .map((c) => ({
            handle: c.handle,
            path: c.path,
            startLine: c.start_line,
            endLine: c.end_line,
          })),
        cost: costs.get(String(t.run_handle)) ?? null,
      })),
    }
  }

  /** Clears the reader's thread for this repository: every turn erased, the next question starts a new thread. */
  async clearHistory({ auth, scope, response }: HttpContext) {
    const user = auth.getUserOrFail()
    const repository = scope.repository!
    const actor = { userId: user.id, workspaceId: scope.workspace.id }
    await inScope(actor, async (trx) => {
      const turns = await trx
        .from('turns')
        .join('threads', 'threads.id', 'turns.thread_id')
        .where({ 'threads.repository_id': repository.id, 'threads.user_id': user.id })
        .whereNull('turns.erased_at')
        .select('turns.id')
      for (const turn of turns) await eraseTurn(trx, String(turn.id))
    })
    return response.noContent()
  }

  /** One turn as an SSE stream; every frame comes from the single encoder (INV-14). */
  async stream({ auth, scope, request, response }: HttpContext) {
    const user = auth.getUserOrFail()
    const repository = scope.repository!
    const body = await request.validateUsing(turnValidator)
    try {
      checkInput(body.question, request.allFiles() && Object.keys(request.allFiles()).length > 0)
    } catch (error) {
      if (error instanceof InputRejectedError) {
        const message = REJECTIONS[error.reason].replace(
          '{cap}',
          String(scopePolicy().inputCapCharacters)
        )
        // Too long to route, but not too long to read: what the paste names becomes questions (BL-09).
        const fromPaste =
          error.reason === 'too_long' && repository.activeCommitId
            ? suggestionsFromPaste(
                body.question,
                await loadVocabulary(
                  { userId: user.id, workspaceId: scope.workspace.id },
                  repository.activeCommitId
                )
              )
            : []
        return response.unprocessableEntity({
          errors: [
            { field: 'question', message, reason: error.reason, suggestedQuestions: fromPaste },
          ],
        })
      }
      throw error
    }
    if (!repository.activeCommitId) {
      return response.unprocessableEntity({
        errors: [{ field: 'repository', message: 'not indexed yet' }],
      })
    }

    const controller = new AbortController()
    request.request.on('close', () => controller.abort())
    const events = answerTurn(
      {
        scope: { userId: user.id, workspaceId: scope.workspace.id },
        repository: {
          id: repository.id,
          name: repository.name,
          activeCommitId: repository.activeCommitId,
        },
        question: body.question,
        threadHandle: body.threadHandle,
        regenerate: body.regenerate,
        requestId: request.id(),
      },
      controller.signal
    )
    // The first event is awaited before the stream opens: an input rejection raised while
    // the turn starts (a regeneration claim, for one) is a 422, and any other error reaches
    // the exception handler, which logs it. Once streaming, an error cannot change the
    // status; a stream error would otherwise end as a bare 500 with nothing recorded.
    const iterator = events[Symbol.asyncIterator]()
    let first: IteratorResult<AnswerEvent>
    try {
      first = await iterator.next()
    } catch (error) {
      if (error instanceof InputRejectedError) {
        return response.unprocessableEntity({
          errors: [{ field: 'question', message: REJECTIONS[error.reason], reason: error.reason }],
        })
      }
      throw error
    }
    response.header('Content-Type', 'text/event-stream')
    response.header('X-Assets-Version', assetsVersion())
    response.header('Cache-Control', 'no-cache')
    response.header('X-Accel-Buffering', 'no')
    response.stream(Readable.from(frames(first, iterator)))
  }
}

async function* frames(first: IteratorResult<AnswerEvent>, rest: AsyncIterator<AnswerEvent>) {
  let chunk = ''
  const encoder = new AnswerEventEncoder({ write: (c) => (chunk += c) })
  let result = first
  while (!result.done) {
    encoder.write(result.value)
    yield chunk
    chunk = ''
    result = await rest.next()
  }
}
