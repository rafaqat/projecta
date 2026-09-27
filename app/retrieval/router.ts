import { readFileSync } from 'node:fs'
import app from '@adonisjs/core/services/app'
import { setQuestion } from '#app/assistant/set_question'

/**
 * Question routing (design §5). Stage 1 is deterministic and comes
 * from config/scope-policy.json (part of configHash); stage 2 is a cheap
 * classifier that can only choose from the closed label set. Neither is the
 * boundary: the evidence gate in WP-06 is. Every decision is stamped on the
 * active span as app.scope.label / stage / rule_id.
 */
export type RouteLabel =
  'enumeration' | 'usage' | 'explanation' | 'absence' | 'similarity' | 'out_of_scope' | 'ambiguous'
export const ROUTE_LABELS: RouteLabel[] = [
  'enumeration',
  'usage',
  'explanation',
  'absence',
  'similarity',
  'out_of_scope',
  'ambiguous',
]

export type RouteStage = 'rule' | 'classifier' | 'throttle' | 'output_gate'

export interface RouteDecision {
  label: RouteLabel
  stage: RouteStage
  ruleId: string
  anchors: string[]
}

export interface IndexVocabulary {
  symbols: string[]
  paths: string[]
  packages: string[]
  factTerms: string[]
  /** Tier 1 API names of the commit's locked dependencies; a separate namespace, never repository evidence. */
  dependencySymbols?: string[]
  /** The commit's extracted HTTP endpoints as `METHOD /path` (WP-11), so an answer may name a route. */
  endpoints?: string[]
  /** Names modules bind by import (`appSettings` for a default export): anchors and verifiable, never suggested. */
  importedNames?: string[]
  /** Names bound by importing from a package (`GoogleStrategy` from passport-google-oauth20): that package's API. */
  packageImports?: string[]
  /** Every identifier in the text of the commit's non-ignored files, for the verifier only. */
  textIdentifiers?: ReadonlySet<string>
  /** Functions and methods with their spans, for the body-coverage check. */
  callables?: Array<{ qualifiedName: string; path: string; startLine: number; endLine: number }>
  /** Symbols by incoming resolved references, most first: what the commit actually calls. */
  mostReferenced?: string[]
  /** Code files by declared symbols, most first: where the commit's code is. */
  busiestPaths?: string[]
  /** Manifests recorded at the commit, read or not. */
  manifests?: number
}

export interface ScopePolicy {
  version: number
  inputCapCharacters: number
  bins: { generalConcepts: string; codeGeneration: string }
  rules: {
    generationVerbs: string[]
    generationTargets: string[]
    absenceForms: string[]
    taskVerbs: string[]
    routerVocabulary: string[]
    /** English words that are also identifiers or package names: they anchor only when backticked or qualified (BL-07). */
    commonWords: string[]
  }
  throttle: { outOfScopeDecisions: number; windowMinutes: number }
  templates: Record<
    'outOfScope' | 'absence' | 'notFound' | 'decline' | 'withheld' | 'error' | 'noInstance',
    string
  >
  gate: {
    connectiveSentences: number
    backgroundTokens: number
    /** Budgets for anchored-only answers (WP-19, BL-12). */
    anchoredOnly: { connectiveSentences: number; backgroundTokens: number }
    calibration: null | Record<string, unknown>
  }
  budgets: {
    candidatesPerRetriever: number
    contextChunks: number
    maxChunksPerFile: number
    suggestedQuestions: number
    sufficiencyMinScore: number
    /** Chunks per evidence pack; absent on policies written before it. */
    pack?: number
    /** Per exact term matched, added to the fused score; 0 or absent disables it. */
    exactMatchBonus?: number
  }
}

let cached: ScopePolicy | undefined
export function scopePolicy(): ScopePolicy {
  cached ??= JSON.parse(
    readFileSync(app.makePath('config/scope-policy.json'), 'utf8')
  ) as ScopePolicy
  return cached
}

const IDENTIFIER =
  /`([^`]+)`|\b([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z]+[A-Z][A-Za-z0-9]*)\b|\b([\w-]+\/[\w./-]+)\b/g

/**
 * One matching form for both sides (BL-07): NFKC so a full-width or
 * ligature spelling of an ASCII identifier matches, lower case so case is
 * never the difference. Nothing else is folded.
 */
const fold = (term: string) => term.normalize('NFKC').toLowerCase()

/**
 * Repository anchors named in the question: indexed symbols, paths, packages
 * or fact terms. Identifier-shaped mentions (backticked, dotted, camel-case,
 * paths) match any term; a plain word matches only packages and fact terms
 * outside the policy's common-word list, so "moment" and "passport" anchor
 * when backticked and never as English.
 */
export function findAnchors(
  question: string,
  vocabulary: IndexVocabulary,
  policy = scopePolicy()
): string[] {
  const q = question.normalize('NFKC')
  const known = new Set<string>()
  for (const list of [
    vocabulary.symbols,
    vocabulary.importedNames ?? [],
    vocabulary.paths,
    vocabulary.packages,
    vocabulary.factTerms,
  ]) {
    for (const term of list) known.add(fold(term))
  }
  const shortNames = new Set(vocabulary.symbols.map((s) => fold(s.split('.').pop()!)))
  const anchors = new Set<string>()
  for (const match of q.matchAll(IDENTIFIER)) {
    const candidate = fold(match[1] ?? match[2] ?? match[3])
    if (known.has(candidate) || shortNames.has(candidate)) anchors.add(candidate)
  }
  const common = new Set(policy.rules.commonWords.map(fold))
  const plainWordTerms = new Set([...vocabulary.packages, ...vocabulary.factTerms].map(fold))
  for (const word of q.toLowerCase().match(/[a-z][a-z0-9_-]+/g) ?? []) {
    if (word.length > 2 && plainWordTerms.has(word) && !common.has(word)) anchors.add(word)
  }
  return Array.from(anchors)
}

const USAGE =
  /\b(who|what|which|where) (files? )?(calls?|uses?|invokes?|references?|imports?)\b|\bcallers?\b|\busages?\b|\bused by\b|\b(tested|mounted|registered|called|used)\b/
const ENUMERATION =
  /\b(list|enumerate|show( me| all)?|what are the|which|what)\b.*\b(endpoints?|routes?|methods?|dependencies|packages|libraries|files|services|handlers|functions|classes|members)\b/
/**
 * A question about the repository itself — what it does, how it is organised, where it starts —
 * is in scope without a named anchor: the map answers it (UAT 2026-09-16).
 */
export const OVERVIEW =
  /\b(this|the|our) (repo|repository|codebase|code base|project|application|app|service|library)\b|\b(codebase|repository|repo|project|application)\b.*\b(organi[sz]ed|structured|structure|architecture|work|works|do|does|about|overview|layout|start|starts|startup|entry ?points?)\b|\b(entry ?points?|startup)\b/i
/** "Where is <feature> implemented / handled / defined", "which files handle X": the located files answer it (UAT 2026-09-16). */
export const LOCATE =
  /\b(where|which files?|what files?|in which files?)\b.*\b(implemented|implement|implements|handled|handle|handles|defined|define|defines|located|live|lives|done|happen|happens|configured|processed|validated|enforced)\b/i
/** "How does X work", "trace a request", "walk through", "what happens when": the call flow answers it. */
export const TRACE =
  /\bhow (does|do|is|are) .+ (work|works|implemented|handled|processed|flow|flows)\b|\btrace\b|\bwalk (me )?through\b|\bwhat happens (when|during|after|on)\b|\bflow of\b|\bend[- ]to[- ]end\b/i
/** The repository's manifests are the repository: an enumeration of what it depends on is in scope without a named anchor. */
const DEPENDENCY_ENUMERATION =
  /\b(list|enumerate|show( me| all)?|what are( the)?|which|what)\b.*\b(dependencies|packages|libraries|libs)\b/
const SIMILARITY = /\bduplicat|\bsimilar\b|\bcopy of\b|\brepeated\b|\bclone/
/** A bare dependency enumeration, answered by the index alone: nothing asked beyond the list. */
export const BARE_DEPENDENCY_ENUMERATION =
  /^\s*(?:show(?: me)?(?: all)?|list(?: all)?|enumerate|what are)(?: the)?(?: (?:direct|dev|runtime))? (?:dependencies|packages|libraries|libs)(?: (?:of|in|for) (?:this|the) (?:repo|repository|app|application|project|codebase))?\s*[?.!]?\s*$/i

function routeByType(question: string): RouteLabel {
  const q = question.toLowerCase()
  if (USAGE.test(q)) return 'usage'
  if (ENUMERATION.test(q)) return 'enumeration'
  if (SIMILARITY.test(q)) return 'similarity'
  return 'explanation'
}

/** Stage 1 in's order; null means "go to stage 2". */
export function routeStage1(
  question: string,
  vocabulary: IndexVocabulary,
  policy = scopePolicy()
): RouteDecision | null {
  const q = question.toLowerCase().trim()
  const anchors = findAnchors(question, vocabulary, policy)
  const { generationVerbs, generationTargets, absenceForms, taskVerbs, routerVocabulary } =
    policy.rules

  // A generation verb aimed at a target noun, or directly at a backticked repository anchor
  // ("rewrite `requireAuth` to use JWTs"): generated code cannot be cited (docs/scope-policy.md).
  const verbs = generationVerbs.join('|')
  const generation = new RegExp(
    `^(?:please |can you |could you )?(?:${verbs})\\b[^.?!]*\\b(?:${generationTargets.join('|')})\\b`
  )
  const generationAtAnchor = new RegExp(
    `^(?:please |can you |could you )?(?:${verbs})\\b[^.?!]*` + '`[^`]+`'
  )
  // The same verb opening the question and aimed at a plain-word anchor ("fix the off-by-one
  // in isOverLimit"): the anchor makes it a generation request about repository code.
  const opensWithVerb = new RegExp(`^(?:please |can you |could you )?(?:${verbs})\\b`)
  if (
    generation.test(q) ||
    generationAtAnchor.test(q) ||
    (anchors.length > 0 && opensWithVerb.test(q))
  ) {
    return {
      label: policy.bins.codeGeneration as RouteLabel,
      stage: 'rule',
      ruleId: 'S1-01-code-generation',
      anchors,
    }
  }
  if (anchors.length > 0) {
    return { label: routeByType(question), stage: 'rule', ruleId: 'S1-02-anchor', anchors }
  }
  if (DEPENDENCY_ENUMERATION.test(q)) {
    return { label: 'enumeration', stage: 'rule', ruleId: 'S1-05-manifests', anchors }
  }
  // A set question over the endpoints, or its continuation, is answered by the index's table and
  // the handlers' code: decided here, never by the classifier.
  if (setQuestion(question)) {
    return { label: 'enumeration', stage: 'rule', ruleId: 'S1-08-set', anchors }
  }
  // Whole words only, and only opening the question or a clause: "does this repository" is not
  // the form "does this repo", and "what does it mean" is not "does it".
  if (absenceForms.some((form) => new RegExp(`(^|[,;:]\\s*)${form}(?=\\s|[?.!,]|$)`).test(q))) {
    return { label: 'absence', stage: 'rule', ruleId: 'S1-03-absence-form', anchors }
  }
  const hasVocabulary = routerVocabulary.some((term) => q.includes(term))
  if (
    !hasVocabulary &&
    taskVerbs.some((verb) => q.startsWith(verb) || q.startsWith(`please ${verb}`))
  ) {
    return { label: 'out_of_scope', stage: 'rule', ruleId: 'S1-04-task-without-anchor', anchors }
  }
  // After the absence forms: "does this repo use closures?" is an absence question about
  // closures, not an overview of the repository. Never an imperative: "Build me a rate limiter
  // for this app" opens with a generation verb and is decided by the classifier (benign
  // case build-generation).
  const imperative =
    opensWithVerb.test(q) ||
    taskVerbs.some((verb) => q.startsWith(verb) || q.startsWith(`please ${verb}`))
  if (!imperative && OVERVIEW.test(q)) {
    return { label: 'explanation', stage: 'rule', ruleId: 'S1-06-overview', anchors }
  }
  if (!imperative && LOCATE.test(q)) {
    return { label: 'explanation', stage: 'rule', ruleId: 'S1-07-locate', anchors }
  }
  return null
}

/** Records the decision on the active span (allowlisted attributes/033). */
export function recordScopeDecision(_decision: RouteDecision): void {
  // OpenTelemetry span attributes (/033) are wired back when the telemetry slice lands.
}
