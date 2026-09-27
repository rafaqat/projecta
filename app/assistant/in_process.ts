import { runAgent, type AgentLimits, type PreRun } from '#app/assistant/agent'
import { canaryBlock, sampled } from '#app/assistant/compliance_canary'
import { mintCanary } from '#guards/index'
import env from '#start/env'
import { MARKER, TurnEvidence } from '#app/assistant/evidence'
import { createHash } from 'node:crypto'
import logger from '@adonisjs/core/services/logger'
import { defaultInjectionDetector, type InjectionDetector } from '#app/parse/injection'
import { GeneralParser } from '#app/assistant/general_parser'
import type { ModelClient, SearchResultBlock } from '#app/assistant/model'
import { namedPaths } from '#app/retrieval/entity_check'
import {
  ResumeUnsupportedError,
  type HumanDecision,
  type Orchestrator,
  type TurnInput,
} from '#app/assistant/orchestrator'
import { PROMPTS } from '#app/assistant/prompts/index'
import type { AnswerEvent } from '#app/assistant/protocol'
import {
  readOnlyTools,
  usagesIntoEvidence,
  dependenciesIntoEvidence,
  outlineIntoEvidence,
  mapIntoEvidence,
  locateIntoEvidence,
  traceIntoEvidence,
  endpointsIntoEvidence,
  subjectCodeIntoEvidence,
  type Tool,
  type ToolContext,
} from '#app/assistant/tools'
import { routeQuestion, type RoutedQuestion, type RouteContext } from '#app/retrieval/answer_route'
import {
  BARE_DEPENDENCY_ENUMERATION,
  LOCATE,
  OVERVIEW,
  TRACE,
  scopePolicy,
} from '#app/retrieval/router'
import { repoMap } from '#app/retrieval/repo_map'
import { completingChunkIds } from '#app/retrieval/subject_code'
import { buildEvidencePack, relationLabel } from '#app/retrieval/evidence_pack'
import { loadVocabulary } from '#app/retrieval/vocabulary'
import { evidenceMode } from '#app/audit/config_hash'
import { testSeam } from '#app/security/ablation_switch'
import { aboutOwnEndpoints, setQuestion } from '#app/assistant/set_question'
import { featureWords } from '#app/retrieval/locate'
import type { ScopeClassifier } from '#app/retrieval/scope_classifier'
import type { ScopeThrottle } from '#app/retrieval/throttle'
import { securityEvents } from '#app/security/events/index'
import { derivationKey, workspaceKey } from '#app/security/derivation_keys'
import { newHandle } from '#app/security/handles'

/** A question about a request's or the application's path from its start: the first entry point is the root. */
const ENTRY_QUESTION = /\b(request|startup|start up|starts|boot|entry ?point|launch)\b/i
/** A question about the HTTP endpoints or routes: the table and the handlers' code answer first. */
const ENDPOINT_QUESTION = /\b(end ?points?|routes?|http api|api routes?)\b/i
/** An enumeration about what the repository depends on: the manifests answer first. */
const DEPENDENCY_QUESTION = /\b(dependenc|package|librar|libs\b)/i

/**
 * The in-process Orchestrator: routes the question (WP-05),
 * builds turn evidence, runs the loop and maps its events onto the
 * closed AnswerEvent union. It keeps no run state after the turn and never
 * pauses, so `resume` rejects before any work. Model text leaves here
 * unreleased: the EvidenceGate outside this class decides what the client
 * sees.
 */
/** The key the gateway verifies with: one secret, two domains. */
const canaryKey = () => env.get('HONEYTOKEN_HMAC_KEY', 'local-honeytoken-key')

export interface InProcessDeps {
  model: ModelClient
  classifier: ScopeClassifier
  throttle: ScopeThrottle
  limits?: Partial<AgentLimits>
  tools?: (ctx: ToolContext) => Tool[]
  route?: (question: string, ctx: RouteContext) => Promise<RoutedQuestion>
  /** Scores the question for annotation; the pinned classifier by default. */
  detector?: InjectionDetector
  /**
   * The compliance canary: on a sampled turn the evidence carries one synthetic block
   * asking for a token to be appended, which reaches the gateway only if the model followed an
   * instruction it read in its evidence. `draw` is the seam a test replaces.
   */
  canarySampling?: { rate: number; draw?: () => number }
}

export class InProcessOrchestrator implements Orchestrator {
  constructor(private readonly deps: InProcessDeps) {}

  get modelId(): string {
    return this.deps.model.id
  }

  async *run(input: TurnInput, signal: AbortSignal): AsyncIterable<AnswerEvent> {
    const runId = newHandle() // opaque, assigned before retrieval
    const status = (label: string, runState: 'running' | 'completed' | 'cancelled' | 'failed') =>
      ({ type: 'status', label, runId, runState }) as const
    yield status('running', 'running')
    try {
      // Scored in parallel with routing and retrieval; annotation only, never a gate.
      const questionSuspected = this.scoreQuestion(input.question, input.call?.requestId)
      const routed = await (this.deps.route ?? routeQuestion)(input.question, {
        scope: input.scope,
        commitId: input.commitId,
        repository: input.repositoryName,
        commitSha: input.commitSha,
        classifier: this.deps.classifier,
        throttle: this.deps.throttle,
        call: input.call && { ...input.call, purpose: 'scope_classification' },
      })
      const traceOut = input.trace
      if (traceOut) {
        traceOut.runId = runId
        traceOut.scope = {
          label: routed.decision.label,
          stage: routed.decision.stage,
          ruleId: routed.decision.ruleId,
        }
        traceOut.modelCalls += routed.modelCalls
      }
      if (routed.notice) {
        yield { type: 'view', component: 'scope_notice', data: routed.notice }
        yield status('completed', 'completed')
        return
      }
      // The bin, for the gate's per-bin budgets (BL-12): anchored-only is a classifier-decided
      // question that names nothing in the repository.
      const anchoredOnly =
        routed.decision.stage === 'classifier' && routed.decision.anchors.length === 0
      yield status(anchoredOnly ? 'scope:anchored_only' : 'scope:in_scope', 'running')
      // Anchored on a name the index has: the gate never calls such a question out of scope (BL-08).
      if (routed.decision.anchors.length > 0) yield status('scope:anchored', 'running')
      const retrieval = routed.retrieval!
      if (traceOut) {
        traceOut.retrieval = {
          status: retrieval.status,
          shown: retrieval.shown,
          total: retrieval.total,
          truncated: retrieval.truncated,
          queriesRun: retrieval.queriesRun,
          excludedPaths: retrieval.excludedPaths,
          candidates: retrieval.chunks.map((c, rank) => ({
            chunkId: c.id,
            path: c.path,
            span: { start: c.startLine, end: c.endLine },
            rank: rank + 1,
          })),
        }
      }
      yield status(`retrieval:${retrieval.status}`, 'running')
      const evidence = new TurnEvidence(input.scope, input.commitSha)
      input.onEvidence?.(evidence)
      // The evidence path: the pack — what the question names, expanded through the
      // index's links, every block titled by its relation — or the routed path: retrieval plus
      // read_code. Retrieval still runs on both, for the trace and the absence route; under `pack`
      // its chunks follow the pack within the same first message. The pre-runs that give
      // the reader a view (usages, outline, located files, the flow) run on both paths.
      const packed = evidenceMode() === 'pack'
      const evidenceBlocks: SearchResultBlock[] = []
      if (packed) {
        const vocabulary = await loadVocabulary(input.scope, input.commitId)
        const pack = await buildEvidencePack(
          input.scope,
          input.commitId,
          input.question,
          routed.decision.anchors,
          vocabulary.packages
        )
        const labels = new Map(pack.items.map((i) => [i.chunkId, relationLabel(i)]))
        evidenceBlocks.push(
          ...(await evidence.addChunks(
            pack.items.map((i) => i.chunkId),
            labels
          ))
        )
        if (traceOut)
          traceOut.pack = {
            seedSource: pack.seedSource,
            seeds: pack.seeds.map((s) => s.name),
            items: pack.items.length,
          }
        const packIds = new Set(pack.items.map((i) => i.chunkId))
        evidenceBlocks.push(
          ...(await evidence.addChunks(
            retrieval.chunks.map((c) => c.id).filter((id) => !packIds.has(id))
          ))
        )
      } else {
        evidenceBlocks.push(...(await evidence.addChunks(retrieval.chunks.map((c) => c.id))))
        // A function retrieval returned only part of is completed, so it is described from its
        // whole body, not from a signature or a fragment.
        evidenceBlocks.push(
          ...(await evidence.addChunks(
            await completingChunkIds(
              input.scope,
              retrieval.chunks.map((c) => c.id)
            )
          ))
        )
      }
      // The compliance canary, last so it displaces nothing: not a chunk, not a handle,
      // and gone when the turn ends. It measures on real traffic what the live lane can only
      // sample on twelve fixture cases.
      const sampling = this.deps.canarySampling
      if (sampling && sampled(sampling.rate, sampling.draw)) {
        evidenceBlocks.push(canaryBlock(mintCanary(canaryKey())))
        if (traceOut) traceOut.canary = true
      }
      // Tools the index runs before the model's first turn; each reaches the model as a tool
      // result after the question (design §6), never as text pasted beside it.
      const preRuns: PreRun[] = []
      if (traceOut?.retrieval) {
        // The record names evidence that ingest flagged as instruction-shaped, so a reviewer
        // can see that an answer was built on it (T-07); the model is never told.
        const flagged = evidence.flaggedChunkIds()
        for (const candidate of traceOut.retrieval.candidates)
          candidate.injectionSuspected = flagged.has(candidate.chunkId)
      }
      if (traceOut) traceOut.questionSuspected = await questionSuspected
      const parser = new GeneralParser()
      const markers = new MarkerBuffer()
      const pendingViews: Array<Extract<AnswerEvent, { type: 'view' }>> = []
      // Who chose each view: a router pre-run (index) or the model's own tool call (model). Set to
      // 'model' once the agent loop starts (B1).
      let viewSource: 'index' | 'model' = 'index'
      const toolContext: ToolContext = {
        scope: input.scope,
        commitId: input.commitId,
        evidence,
        emitView: (component, data) => {
          pendingViews.push({ type: 'view', component, data })
          if (component !== 'scope_notice' && traceOut)
            (traceOut.views ??= []).push({ component, source: viewSource })
        },
        emitted: new Set(),
      }
      // "Who calls X?": the index answers first (design §6). The usage table is a view of its
      // own, and the sites join the evidence so the model's prose about them can cite them.
      if (routed.decision.label === 'usage') {
        // Anchors are folded for matching; the identifier is the question's own spelling of it.
        const spelled = input.question.match(/[A-Za-z_$][\w$]*/g) ?? []
        const identifiers = new Set<string>()
        for (const anchor of routed.decision.anchors) {
          const short = anchor.split('.').pop() ?? anchor
          const word = spelled.find((w) => w.toLowerCase() === short.toLowerCase())
          if (word) identifiers.add(word)
        }
        for (const identifier of [...identifiers].slice(0, 2)) {
          const content = await usagesIntoEvidence(toolContext, identifier)
          if (content.length) preRuns.push({ name: 'find_usages', input: { identifier }, content })
        }
        yield* pendingViews.splice(0)
      }
      // "What is implemented in `<file>`?": the file's outline and its chunks, before the model
      // searches for pieces of it (UAT 2026-09-15, addProduct.js). One path per turn: the first
      // the question names that exists at the commit.
      if (routed.decision.label !== 'usage') {
        for (const named of namedPaths(input.question).slice(0, 2)) {
          const content = await outlineIntoEvidence(toolContext, named)
          if (content.length === 0) continue
          preRuns.push({ name: 'file_outline', input: { path: named }, content })
          yield* pendingViews.splice(0)
          break
        }
      }
      // "What does X do": the bodies of the functions, classes and route handlers the question
      // names, before the model describes them — never from a name or a signature.
      if (!packed && routed.decision.label !== 'usage') {
        const names = [
          ...new Set([
            // Anchors are folded for matching; the model sees the question's own spelling.
            ...routed.decision.anchors
              .filter((a) => !a.includes('/'))
              .map(
                (a) =>
                  (input.question.match(/[A-Za-z_$][\w$.]*/g) ?? []).find(
                    (w) => w.toLowerCase() === a.toLowerCase()
                  ) ?? a
              ),
            ...(input.question.match(/(?:^|[\s`'"(])\/[\w\-/:.{}*]*/g) ?? []).map((m) =>
              m.replace(/^[\s`'"(]/, '').replace(/[.,;:?!]+$/, '')
            ),
          ]),
        ].slice(0, 3)
        if (names.length) {
          const content = await subjectCodeIntoEvidence(toolContext, input.question, names)
          if (content.length) preRuns.push({ name: 'read_code', input: { names }, content })
        }
      }
      // "List / explain the endpoints": the table with each row's handler and the handlers' code
      //, before the model describes routes it has not read.
      if (
        routed.decision.label !== 'usage' &&
        (ENDPOINT_QUESTION.test(input.question) || aboutOwnEndpoints(input.question))
      ) {
        // A set question is answered one cited batch at a time.
        const set = setQuestion(input.question)
        if (set) toolContext.batch = { from: set.from, to: set.to }
        // A test may shrink the batch budget to see the batches (seam; test envs only).
        const chunkCap = await testSeam<number>('handlerChunks')
        const content = await endpointsIntoEvidence(
          toolContext,
          chunkCap,
          set ? { from: set.from, to: set.to } : undefined
        )
        if (content.length) preRuns.push({ name: 'list_endpoints', input: {}, content })
        yield* pendingViews.splice(0)
      }
      // "How is this repository organised?": the map, before the model searches for a shape no
      // chunk states (UAT 2026-09-16).
      // A set question ("explain each API this app implements") is not an overview: the map would
      // put the README first and the model would open with it instead of the batch (UAT 2026-09-17).
      if (
        !setQuestion(input.question) &&
        (routed.decision.ruleId === 'S1-06-overview' || OVERVIEW.test(input.question))
      ) {
        const content = await mapIntoEvidence(toolContext)
        if (content.length) preRuns.push({ name: 'repo_map', input: {}, content })
        yield* pendingViews.splice(0)
      }
      // "Where is <feature> implemented?": the located files, before the model reads one lucky
      // chunk (UAT 2026-09-16). Not for a usage question: its symbol anchor is the answer.
      if (routed.decision.label !== 'usage' && LOCATE.test(input.question)) {
        const content = await locateIntoEvidence(toolContext, input.question)
        if (content.length)
          preRuns.push({ name: 'locate', input: { words: featureWords(input.question) }, content })
        yield* pendingViews.splice(0)
      }
      // "How does X work / trace a request": the call flow from the symbol the question names,
      // or from the first entry point when it asks about a request or startup (UAT 2026-09-16).
      if (routed.decision.label !== 'usage' && TRACE.test(input.question)) {
        const spelled = input.question.match(/[A-Za-z_$][\w$.]*/g) ?? []
        const symbolAnchor = routed.decision.anchors
          .map((anchor) => spelled.find((w) => w.toLowerCase() === anchor.toLowerCase()) ?? null)
          .find((w): w is string => Boolean(w) && !/[/]/.test(w!))
        let from: string | null = symbolAnchor ?? null
        if (!from && ENTRY_QUESTION.test(input.question)) {
          const map = await repoMap(input.scope, input.commitId)
          from = map.entryPoints[0]?.path ?? null
        }
        if (from) {
          // A request's path starts at its entry: walk callers up from the named symbol.
          const fromEntry = Boolean(symbolAnchor) && ENTRY_QUESTION.test(input.question)
          const content = await traceIntoEvidence(toolContext, from, 3, { fromEntry })
          if (content.length) preRuns.push({ name: 'trace', input: { from, fromEntry }, content })
          yield* pendingViews.splice(0)
        }
      }
      // "Show me dependencies": every manifest at the commit, read or not, before the model
      // reads one of them. The table is a view; the text and the manifest lines join
      // the evidence so the model narrates what the index found and cites the declarations.
      if (routed.decision.label === 'enumeration' && DEPENDENCY_QUESTION.test(input.question)) {
        const content = await dependenciesIntoEvidence(toolContext)
        if (content.length) preRuns.push({ name: 'dependency_graph', input: {}, content })
        yield* pendingViews.splice(0)
        // A bare enumeration is the card and its computed summary: the index answers, no model
        // call. Any other dependency question goes on to the model with the card as evidence.
        if (content.length && BARE_DEPENDENCY_ENUMERATION.test(input.question)) {
          yield status('completed', 'completed')
          return
        }
      }
      const templates = scopePolicy().templates
      let outcome: AnswerEvent = status('completed', 'completed')
      let noInstance = false
      let modelSearches = 0
      // Uncited text waits for what follows it in the model's turn: a citation releases it
      // (connective prose before a cited claim), a tool call discards it (the model narrating
      // its search, "Let me look for..." — process, never answer; the prompt forbids it and
      // the gate would otherwise release it as connective text), the end of the turn releases it.
      let pendingText: Extract<AnswerEvent, { type: 'text' | 'background' }>[] = []
      let narrationDropped = 0

      viewSource = 'model'
      for await (const event of runAgent(
        {
          model: this.deps.model,
          system: PROMPTS.system.text,
          question: input.question,
          evidenceBlocks,
          preRuns,
          tools: (this.deps.tools ?? readOnlyTools)(toolContext),
          evidence,
          continuation: input.continuation,
          strict: input.strict,
          limits: this.deps.limits,
          call: input.call,
        },
        signal
      )) {
        if (event.type === 'text') {
          for (const segment of parser.feed(event.delta)) {
            if (segment.kind === 'decline') {
              if (anchoredOnly) {
                // Routing already decided this question is in scope; the model does not get to
                // refuse it (BL-08). The tag is dropped; whatever else it cites still counts.
                securityEvents.emit('policy.enforced', {
                  rule: 'scope.decline_ignored',
                  decision: 'ignored',
                })
                continue
              }
              yield {
                type: 'view',
                component: 'scope_notice',
                data: {
                  component: 'scope_notice',
                  kind: 'decline',
                  text: templates.decline,
                  suggestedQuestions: [],
                },
              }
              continue
            }
            if (segment.kind === 'no_instance') {
              const searches =
                traceOut?.tools.filter((t) => t.name === 'search_code').length ?? modelSearches
              if (searches === 0) {
                // An absence claimed without searching is not accepted (owner review 2026-09-14):
                // the pre-fetched set is the same generic dozen for most concept questions.
                securityEvents.emit('policy.enforced', {
                  rule: 'no_instance.unsearched',
                  decision: 'ignored',
                })
                continue
              }
              // The absence of a concept is evidence by construction: the notice is built from what
              // was retrieved and what the model searched for itself; its prose is never released.
              noInstance = true
              yield {
                type: 'view',
                component: 'scope_notice',
                data: {
                  component: 'scope_notice',
                  kind: 'no_instance',
                  text: templates.noInstance
                    .replace('{repository}', input.repositoryName)
                    .replace('{commit}', input.commitSha.slice(0, 7)),
                  suggestedQuestions: routed.suggestions ?? [],
                  queriesRun: retrieval.queriesRun,
                  excludedPaths: retrieval.excludedPaths,
                  evidenceExamined: {
                    results: evidence.handles().length,
                    files: evidence.paths(),
                    modelSearches:
                      traceOut?.tools.filter((t) => t.name === 'search_code').length ??
                      modelSearches,
                  },
                },
              }
              continue
            }
            if (noInstance) continue
            for (const piece of markers.feed(segment.text)) {
              if (typeof piece === 'string') {
                pendingText.push(
                  segment.kind === 'general'
                    ? { type: 'background', delta: piece }
                    : { type: 'text', delta: piece, block: event.block }
                )
              } else {
                yield* pendingText.splice(0)
                yield* this.cite(evidence.hydrateMarker(piece.handle), piece.handle, evidence)
              }
            }
          }
        } else if (event.type === 'citation') {
          yield* pendingText.splice(0)
          const hydrated = evidence.hydrate(event.native)
          if (!hydrated) {
            // Named so the cause can be read (UAT 2026-09-16: r13–r17 unresolvable on Sejima).
            securityEvents.emit('error.unhandled', {
              errorCode: 'E_CITATION_UNRESOLVED',
              errorHash: createHash('sha256')
                .update(event.native.handle)
                .digest('hex')
                .slice(0, 16),
              requestId: input.call?.requestId ?? '',
            })
            logger.warn(
              {
                handle: event.native.handle,
                reason: evidence.unresolvedReason(event.native),
                startBlock: event.native.startBlock,
                endBlock: event.native.endBlock,
                sent: evidence.describe(event.native.handle),
                citedText: event.native.citedText.slice(0, 80),
              },
              'citation did not resolve'
            )
          }
          yield* this.cite(hydrated, event.native.handle, evidence, event.block)
        } else if (event.type === 'tool') {
          if (pendingText.length) {
            narrationDropped += pendingText.length
            pendingText = []
          }
          if (event.name === 'search_code') modelSearches++
          // Tool arguments can echo the question: the record keeps a workspace-keyed digest.
          traceOut?.tools.push({
            name: event.name,
            argDigest: derivationKey(
              workspaceKey(input.scope.workspaceId!),
              'tool-arg',
              JSON.stringify(event.input ?? null)
            ),
            status: event.status,
          })
          if (event.status === 'refused')
            yield { type: 'policy', rule: 'agent.iteration_cap', action: 'blocked' }
          if (event.status === 'timeout')
            yield { type: 'policy', rule: 'agent.tool_timeout', action: 'blocked' }
          yield* pendingViews.splice(0)
        } else if (event.type === 'model_call') {
          if (traceOut) traceOut.modelCalls++
        } else if (event.type === 'done') {
          if (event.reason === 'aborted') outcome = status('client disconnected', 'cancelled')
          else if (event.reason === 'deadline')
            outcome = status('turn deadline reached', 'cancelled')
          else if (event.reason === 'model_error') outcome = status('model error', 'failed')
          else if (event.reason === 'output_blocked') {
            // What was released before the block stands; the reader is told the rule.
            const rule = event.rule ?? 'output'
            securityEvents.emit('policy.enforced', { rule, decision: 'blocked' })
            yield { type: 'policy', rule, action: 'blocked' }
            outcome = status('output blocked', 'completed')
          } else outcome = status(event.reason, 'completed')
        }
      }
      // The turn is over: what the model wrote after its last claim is answer, not narration.
      yield* pendingText.splice(0)
      for (const segment of parser.end()) {
        if (segment.kind !== 'decline' && segment.kind !== 'no_instance' && !noInstance) {
          const rest = markers.end()
          if (rest)
            yield {
              type: segment.kind === 'general' ? 'background' : 'text',
              delta: segment.text + rest,
            }
        }
      }
      if (narrationDropped)
        logger.info(
          { narrationDropped, requestId: input.call?.requestId ?? '' },
          'narration dropped'
        )
      // Tool-added evidence carries the ingest flag too; the record counts everything the answer was built from.
      if (traceOut) traceOut.flaggedEvidence = evidence.flaggedChunkIds().size
      yield outcome
    } catch (error) {
      // Never swallowed: the code and a message hash reach the log.
      const message = error instanceof Error ? error.message : String(error)
      securityEvents.emit('error.unhandled', {
        errorCode: (error as { code?: string }).code ?? 'E_TURN_FAILED',
        errorHash: createHash('sha256').update(message).digest('hex').slice(0, 16),
        status: 500,
        requestId: input.call?.requestId ?? '',
      })
      yield { type: 'error', message: 'the turn failed' }
      yield status('failed', 'failed')
    }
  }

  /**
   * The question through the pinned classifier. A detector outage is
   * reported with a code and leaves the annotation undefined: fail open, never a gate.
   */
  private async scoreQuestion(question: string, requestId = ''): Promise<boolean | undefined> {
    try {
      return await (this.deps.detector ?? defaultInjectionDetector()).detect(question)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      securityEvents.emit('error.unhandled', {
        errorCode: 'E_DETECTOR_UNAVAILABLE',
        errorHash: createHash('sha256').update(message).digest('hex').slice(0, 16),
        status: 503,
        requestId,
      })
      return undefined
    }
  }

  private async *cite(
    hydrated: Extract<AnswerEvent, { type: 'citation' }> | null,
    handle: string,
    evidence?: TurnEvidence,
    block?: number
  ): AsyncGenerator<AnswerEvent> {
    if (hydrated) {
      // The cited function's internal calls, from the index: pills to drill into them.
      const calls = evidence ? await evidence.calleesOf(handle) : []
      const event = calls.length ? { ...hydrated, calls } : hydrated
      yield block === undefined ? event : { ...event, block }
      return
    }
    // Foreign handle, database ID, SHA or unknown marker: render nothing (INV-13).
    securityEvents.emit('policy.enforced', {
      rule: 'citation.unresolvable_handle',
      decision: 'blocked',
    })
    yield {
      type: 'policy',
      rule: `citation.unresolvable_handle:${handle.slice(0, 16)}`,
      action: 'blocked',
    }
  }

  async *resume(
    runId: string,
    _decision: HumanDecision,
    _signal: AbortSignal
  ): AsyncIterable<AnswerEvent> {
    throw new ResumeUnsupportedError(runId)
  }
}

/** Splits text around `[[cite:rN]]` markers that may straddle deltas. */
class MarkerBuffer {
  private pending = ''

  feed(text: string): Array<string | { handle: string }> {
    let buffer = this.pending + text
    this.pending = ''
    const out: Array<string | { handle: string }> = []
    for (;;) {
      const at = buffer.indexOf('[[')
      if (at === -1) {
        if (buffer) out.push(buffer)
        return out
      }
      if (at > 0) out.push(buffer.slice(0, at))
      buffer = buffer.slice(at)
      const match = MARKER.exec(buffer)
      MARKER.lastIndex = 0
      if (match && match.index === 0) {
        out.push({ handle: match[1] })
        buffer = buffer.slice(match[0].length)
      } else if (buffer.length < 16 && '[[cite:r9999]]'.startsWith(buffer.slice(0, 7))) {
        this.pending = buffer
        return out
      } else {
        out.push('[[')
        buffer = buffer.slice(2)
      }
    }
  }

  end(): string {
    const rest = this.pending
    this.pending = ''
    return rest
  }
}
