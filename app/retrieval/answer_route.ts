import { checkEntities } from '#app/retrieval/entity_check'
import { exclusionsFor, exclusionsNamedBy, type Exclusion } from '#app/retrieval/exclusions'
import { setQuestion } from '#app/assistant/set_question'
import { retrieve, type RetrievalResult } from '#app/retrieval/hybrid'
import {
  recordScopeDecision,
  routeStage1,
  scopePolicy,
  type RouteDecision,
} from '#app/retrieval/router'
import { classifyWithFallback, type ScopeClassifier } from '#app/retrieval/scope_classifier'
import { ScopeThrottle } from '#app/retrieval/throttle'
import { loadVocabulary, suggestedQuestions } from '#app/retrieval/vocabulary'
import { isAblated } from '#app/security/ablation_switch'
import { securityEvents } from '#app/security/events/index'
import type { Scope } from '#app/security/scope'
import type { CallContext } from '#app/audit/ledger'

/**
 * From question to routed evidence (design §5). Out-of-scope and
 * not-found questions end here with a deterministic `scope_notice` and no
 * model call; everything else carries a RetrievalResult forward to the
 * answer loop (WP-06), which owns the evidence gate.
 */
export interface ScopeNotice {
  component: 'scope_notice'
  kind: 'out_of_scope' | 'absence' | 'not_found' | 'decline' | 'error' | 'no_instance'
  text: string
  suggestedQuestions: string[]
  queriesRun?: string[]
  excludedPaths?: string[]
  /** Files the index left out that the question points at, with the reason (WP-19, BL-23). */
  exclusions?: Exclusion[]
  /** What a `no_instance` notice rests on (WP-19): results shown, files covered, and searches the model ran itself. */
  evidenceExamined?: { results: number; files: string[]; modelSearches: number }
  /** The classifier is paused after repeated out-of-scope decisions; shown so the pause is legible (BL-10). */
  throttled?: boolean
  retryAfterSeconds?: number
  missing?: Record<string, string[]>
}

export interface RoutedQuestion {
  decision: RouteDecision
  modelCalls: number
  notice?: ScopeNotice
  retrieval?: RetrievalResult
  /** Deterministic suggested questions for notices rendered later in the turn (no_instance). */
  suggestions?: string[]
}

export interface RouteContext {
  scope: Scope
  commitId: string
  repository: string
  commitSha: string
  classifier: ScopeClassifier
  throttle: ScopeThrottle
  /** Attribution for any provider call made while routing (WP-07). */
  call?: CallContext
}

const policy = scopePolicy()

export function outOfScopeNotice(
  context: Pick<RouteContext, 'repository' | 'commitSha'>,
  suggestions: string[]
): ScopeNotice {
  const text = policy.templates.outOfScope
    .replace('{repository}', context.repository)
    .replace('{commit}', context.commitSha.slice(0, 7))
  return { component: 'scope_notice', kind: 'out_of_scope', text, suggestedQuestions: suggestions }
}

/** Stage-1 rules whose answer comes from the index's own tables, whatever retrieval scores. */
const INDEX_ANSWERED_RULES = new Set([
  'S1-05-manifests',
  'S1-06-overview',
  'S1-07-locate',
  'S1-08-set',
])

export async function routeQuestion(
  question: string,
  context: RouteContext,
  options: { sufficiencyMinScore?: number } = {}
): Promise<RoutedQuestion> {
  const { scope, commitId, classifier, throttle } = context
  if (question.length > policy.inputCapCharacters) {
    throw new RangeError(`input exceeds ${policy.inputCapCharacters} characters`)
  }
  const vocabulary = await loadVocabulary(scope, commitId)
  const suggestions = suggestedQuestions(vocabulary)
  let modelCalls = 0

  let decision = (await isAblated('no_scope_rules')) ? null : routeStage1(question, vocabulary)
  // The entity pre-check runs before any model call (design §5).
  const entities =
    decision?.label === 'out_of_scope'
      ? { missing: [], suggestions: {} }
      : await checkEntities(scope, commitId, question)
  if (!decision && entities.missing.length === 0) {
    if (throttle.isThrottled(scope.userId)) {
      if (throttle.firstThrottle(scope.userId)) {
        securityEvents.emit('policy.enforced', {
          rule: 'scope.throttled',
          decision: 'out_of_scope',
        })
      }
      decision = { label: 'out_of_scope', stage: 'throttle', ruleId: 'S2-throttled', anchors: [] }
    } else if (await isAblated('no_scope_classifier')) {
      // Ablation (enforcement, test targets only): stage 2 absent, the gate alone decides.
      decision = { label: 'ambiguous', stage: 'classifier', ruleId: 'S2-ablated', anchors: [] }
    } else {
      modelCalls++
      const label = await classifyWithFallback(classifier, question, context.call)
      decision = { label, stage: 'classifier', ruleId: `S2-${classifier.id}`, anchors: [] }
    }
  }
  decision ??= { label: 'explanation', stage: 'rule', ruleId: 'S1-05-entity-precheck', anchors: [] }
  recordScopeDecision(decision)

  if (decision.label === 'out_of_scope') {
    // Only rule- and classifier-decided refusals count; a throttled decision must not feed the throttle (BL-10).
    if (decision.stage !== 'throttle') throttle.recordOutOfScope(scope.userId)
    const notice = outOfScopeNotice(context, suggestions)
    if (decision.stage === 'throttle') {
      notice.throttled = true
      notice.retryAfterSeconds = throttle.retryAfterSeconds(scope.userId)
    }
    return { decision, modelCalls, notice }
  }

  if (entities.missing.length > 0) {
    const text = entities.missing
      .map((id) =>
        policy.templates.notFound
          .replace('{identifier}', id)
          .replace('{commit}', context.commitSha.slice(0, 7))
      )
      .join(' ')
    return {
      decision,
      modelCalls,
      notice: {
        component: 'scope_notice',
        kind: 'not_found',
        text,
        suggestedQuestions: suggestions,
        missing: entities.suggestions,
      },
    }
  }

  const retrieval = await retrieve(scope, commitId, question, options)
  // A question anchored on a file or symbol the index has is never declared absent by a
  // retrieval score (BL-08, one step earlier): the model gets what retrieval found and the
  // index's own answer for the anchor — outline, usages — as evidence (UAT 2026-09-16).
  // A rule that decided the index itself answers (manifests, the map) is as good as an anchor.
  // A set question over the endpoints ("explain endpoints 5 to 5") is answered from the index's
  // table and the handlers' code: never absent on a retrieval score.
  const anchored =
    decision.anchors.length > 0 ||
    (decision.stage === 'rule' && INDEX_ANSWERED_RULES.has(decision.ruleId)) ||
    setQuestion(question) !== null
  // An absence form ("is there…", "does it…") keeps its label; the absence notice is for what
  // retrieval did not find, and for a question naming a file the index skipped, which no evidence
  // can answer (AC-WP19-11). Otherwise the model answers from the evidence, citing it or writing
  // <no_instance/> after a search of its own.
  const namesExclusion =
    decision.label === 'absence' &&
    exclusionsNamedBy(question, await exclusionsFor(scope, commitId)).length > 0
  if ((retrieval.status === 'insufficient_evidence' && !anchored) || namesExclusion) {
    return {
      decision,
      modelCalls,
      retrieval,
      notice: {
        component: 'scope_notice',
        kind: 'absence',
        text: policy.templates.absence,
        suggestedQuestions: suggestions,
        queriesRun: retrieval.queriesRun,
        excludedPaths: retrieval.excludedPaths,
        exclusions: exclusionsNamedBy(question, await exclusionsFor(scope, commitId)),
      },
    }
  }
  return { decision, modelCalls, retrieval, suggestions }
}

export function defaultThrottle(): ScopeThrottle {
  return new ScopeThrottle(
    policy.throttle.outOfScopeDecisions,
    policy.throttle.windowMinutes * 60_000
  )
}
