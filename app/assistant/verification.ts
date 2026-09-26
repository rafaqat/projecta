import type { IndexVocabulary } from '#app/retrieval/router'
import type { AnswerEvent } from '#app/assistant/protocol'
import { absenceClaims } from '#app/assistant/absence_claims'

/**
 * Entity verification and citation coverage (design §6, AC-WP06-10; three
 * states from). Code entities in a repository-claim sentence are
 * checked against the index vocabulary: present and cited → verified;
 * present but uncited → flagged; present only in a locked dependency's API
 * surface → dependency; absent from both → unverified. Background sentences
 * are exempt: naming a repository entity there is a contract violation,
 * reported apart.
 */
export type EntityState = 'repository' | 'dependency' | 'unknown'
const ENTITY =
  /`([^`\n]+)`|\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\b|\b([a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z]+[A-Z][A-Za-z0-9]*)\b|\b([\w-]+\/[\w./-]+\.[a-z]{1,4})\b/g

/**
 * Names of languages, platforms and products that read like code entities
 * (camel case, a dot) but are never claims about this repository's symbols.
 * Checked case-insensitively; a repository symbol of the same name would be
 * in the vocabulary and is looked up first by the verifier.
 */
const TECHNOLOGY_NAMES = new Set(
  [
    'JavaScript',
    'TypeScript',
    'Node.js',
    'NodeJS',
    'Node',
    'Deno',
    'Bun',
    'CommonJS',
    'ESM',
    'MongoDB',
    'PostgreSQL',
    'Postgres',
    'MySQL',
    'SQLite',
    'Redis',
    'Elasticsearch',
    'GraphQL',
    'RESTful',
    'REST',
    'HTTP',
    'HTTPS',
    'HTML',
    'CSS',
    'JSON',
    'YAML',
    'XML',
    'JWT',
    'OAuth',
    'OAuth2',
    'OpenID',
    'SAML',
    'GitHub',
    'GitLab',
    'Docker',
    'Kubernetes',
    'Linux',
    'macOS',
    'iOS',
    'Android',
    'Xcode',
    'SwiftUI',
    'UIKit',
    'React',
    'Vue.js',
    'Next.js',
    'Nuxt',
    'Express.js',
    'NestJS',
    'Handlebars',
    'WebSocket',
    'WebSockets',
    'localStorage',
    'sessionStorage',
  ].map((n) => n.toLowerCase())
)

/** A backticked span that is a name (identifier, dotted path, file path) or a `METHOD /path` route, not a snippet. */
const NAME_LIKE = /^[A-Za-z_$@][\w$@./:\-[\]{}?*]*$/
const ROUTE_LIKE = /^[A-Z]+ \/\S*$/
/**
 * A backticked plain lowercase word (`where`, `set`, `limit`, `admin`) or a
 * Latin abbreviation (`e.g`, `i.e`) that nothing in the index or the
 * dependencies declares is a term or a literal, not a claim about a symbol
 * (a symbol reads as camel case, a dotted or slashed path, or carries an
 * underscore, a digit or a capital). One the dependencies do declare
 * (`object` from zod) is still their API.
 */
/** A bare file name with an extension (`SKILL.md`, `package.json`): placed by any path that ends with it. */
const FILE_NAME = /^[^/]+\.[a-z0-9]{1,5}$/
const NODE_BUILTIN = /^node:[a-z_]+(?:\/[a-z_]+)?$/
/** Server frameworks whose handlers receive request and response objects by these conventional names. */
const WEB_FRAMEWORKS = new Set([
  'express',
  'koa',
  'fastify',
  '@hapi/hapi',
  'restify',
  '@nestjs/core',
])
const WEB_REQUEST_OBJECT = /^(req|res|request|response|reply|ctx)\.[A-Za-z_$][\w$.]*$/
/**
 * Apple framework types by their two-letter prefix (UIKit, Foundation, Core Graphics, Core
 * Animation, Core Location, AVFoundation, MapKit, SpriteKit, WebKit, Core Foundation, Contacts,
 * Core Motion, Photos, SwiftUI's SF, ARKit, CloudKit, GameKit, HealthKit, MediaPlayer, User
 * Notifications, WatchConnectivity, os): platform API in a Swift repository, as Node's globals
 * are in a Node one (UAT 2026-09-16: `UIButton` reported as not in the repository). An
 * attribute (`@UIApplicationMain`) names the same type.
 */
const APPLE_PLATFORM =
  /^@?(?:UI|NS|CG|CA|CL|AV|MK|SK|WK|CF|CN|CM|PH|SF|AR|CK|GK|HK|MP|UN|WC|OS)[A-Z][A-Za-z0-9]*(?:\.[A-Za-z_][\w]*)*$/
/**
 * Android, Kotlin and JVM API by package (`androidx.room.RoomDatabase`, `kotlinx.coroutines.launch`)
 * and the unqualified names a Kotlin answer uses without an import: the standard library's
 * functions and the Android framework types every app touches. A name imported by a
 * file is already known through the imported names.
 */
const KOTLIN_PLATFORM_PACKAGE =
  /^@?(?:android|androidx|kotlin|kotlinx|java|javax|dalvik|com\.google\.android)\.[\w.]+$/
const KOTLIN_PLATFORM_NAMES = new Set(
  (
    'listOf mutableListOf arrayListOf mapOf mutableMapOf setOf mutableSetOf emptyList emptyMap ' +
    'emptySet lazy requireNotNull checkNotNull buildList buildString repeat println TODO ' +
    'Unit Any Nothing Pair Triple Result Sequence ' +
    'Context Bundle Intent View ViewGroup Activity Fragment Application Service ' +
    'BroadcastReceiver Parcelable ViewModel LiveData MutableLiveData StateFlow MutableStateFlow Flow ' +
    'Composable Modifier CoroutineScope Dispatchers'
  )
    .split(' ')
    .map((n) => n.toLowerCase())
)

/**
 * Globals of the language and the runtime: a member on one (`Error.captureStackTrace`,
 * `JSON.parse`, `process.env`) is platform API, background like a package's. A
 * repository symbol of the same name wins, as it does for packages.
 */
const PLATFORM_GLOBALS = new Set(
  [
    'Object',
    'Array',
    'String',
    'Number',
    'Boolean',
    'Symbol',
    'BigInt',
    'Function',
    'Error',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'JSON',
    'Math',
    'Date',
    'RegExp',
    'Promise',
    'Map',
    'Set',
    'WeakMap',
    'WeakSet',
    'WeakRef',
    'Reflect',
    'Proxy',
    'Intl',
    'Atomics',
    'ArrayBuffer',
    'SharedArrayBuffer',
    'DataView',
    'Uint8Array',
    'Float32Array',
    'globalThis',
    'console',
    'process',
    'Buffer',
    'URL',
    'URLSearchParams',
    'TextEncoder',
    'TextDecoder',
    'AbortController',
    'fetch',
    'Request',
    'Response',
    'Headers',
    'FormData',
    'Blob',
    'setTimeout',
    'setInterval',
    'clearTimeout',
    'clearInterval',
    'queueMicrotask',
    'structuredClone',
    'crypto',
    'performance',
    'window',
    'document',
    'navigator',
    'localStorage',
    'sessionStorage',
    'require',
    'module',
  ].map((g) => g.toLowerCase())
)
const TERM = /^(?:[a-z]+|e\.g|i\.e|etc|vs)\.?$/
/** Keywords that are not plain lowercase words: Swift's property observers and modifiers (UAT 2026-09-16: `didSet`). */
const KEYWORDS = new Set(
  [
    'didSet',
    'willSet',
    'deinit',
    'fileprivate',
    'inout',
    'rethrows',
    'nonisolated',
    'associatedtype',
    'typealias',
  ].map((k) => k.toLowerCase())
)

/** A URL path: `/editAddress`, `/profile-orders-view-more/:id`. Its segments are not code names. */
const ROUTE_PATH = /(?<![\w./-])\/[\w\-/:.{}]*[\w\-:}]/g

/**
 * Code with its comments blanked: line and block comments become spaces, so positions are kept
 * and a name that lives only in a comment is not found. Lexical on purpose — this runs
 * on cited snippets of any language the index holds, which is the same trade app/parse/prose.ts
 * makes in the other direction.
 */
export function withoutComments(code: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, ' ')
  return code
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)))
    .replace(/^\s*#(?!!)[^\n]*/gm, blank)
    .replace(/^\s*\*[^\n]*/gm, blank)
}

export function codeEntities(sentence: string): string[] {
  const out = new Set<string>()
  // Route paths are blanked first: a camel-case segment (`/editAddress`) would otherwise read as
  // a function of that name (UAT 2026-09-17).
  // A backticked route (`GET /admin`) is checked against the endpoints; only bare ones are blanked.
  const withoutRoutes = sentence.replace(/`[^`\n]+`|[^`]+/g, (part) =>
    part.startsWith('`') ? part : part.replace(ROUTE_PATH, (m) => ' '.repeat(m.length))
  )
  for (const m of withoutRoutes.matchAll(ENTITY)) {
    let entity = (m[1] ?? m[2] ?? m[3] ?? m[4]).trim()
    if (m[1] !== undefined) {
      // `startServer()` names startServer; `npm start` or `"type": "module"` is a snippet, not a claim.
      entity = entity.replace(/\(\)$/, '')
      if (!NAME_LIKE.test(entity) && !ROUTE_LIKE.test(entity)) continue
    } else if (TECHNOLOGY_NAMES.has(entity.toLowerCase())) continue
    out.add(entity)
  }
  return Array.from(out)
}

/** A cited span of code: the file and its line range. */
export interface CodeSpan {
  path: string
  start: number
  end: number
}

/** A function or method of the index, with its lines. */
export interface Callable {
  qualifiedName: string
  path: string
  startLine: number
  endLine: number
}

/** A sentence about where a function is used or wired, not what it does. */
const RELATIONSHIP =
  /\b(handled by|handler (?:is|for)|(?:is |are )?called (?:by|from|in)|calls?|invokes?|invoked by|imports?|imported (?:by|from|in)|registers?|registered|mounted|mounts?|mapped to|maps to|routes? to|routed to|passed to|passes|defined in|declared in|exports?|exported)\b/i

/** A name or a dotted chain of names: what file text and cited code can show. */
const IDENTIFIER_PATH = /^[A-Za-z_$][\w$]*(?:-[\w$]+)*(\.[A-Za-z_$][\w$]*(?:-[\w$]+)*)*$/

/** A declaration of an outlined file, as the decision record lists it. */
export interface OutlinedDeclaration {
  qualifiedName: string
  startLine: number
  endLine: number
}

/** `showError` adds…: a declaration as the subject of a verb — described, not merely named. */
function describesBehaviour(sentence: string, name: string): boolean {
  if (RELATIONSHIP.test(sentence)) return false
  const short = name.replace(/\(\)$/, '').split('.').pop()!
  const verb = new RegExp(
    `(^|[^\\w$\`])\`?${short.replace(/[$]/g, '\\$')}\`?(?:\\([^)]*\\))?\\s+(?:also\\s+|then\\s+|first\\s+)?[a-z]+(?:s|es|ed)\\b`
  )
  return verb.test(sentence)
}

export class EntityVerifier {
  /** Declarations of files whose outline the turn put in evidence, by lower-cased qualified and short name. */
  private readonly outlined = new Map<string, { path: string; line: number }>()
  private readonly known: Set<string>
  private readonly shortNames: Set<string>
  private readonly dependency: Set<string>
  private readonly dependencyShortNames: Set<string>
  private readonly packages: Set<string>
  /** The commit has Swift or Objective-C sources: Apple framework prefixes name platform types. */
  private readonly apple: boolean
  /** The commit has Kotlin sources: Android, Kotlin and JVM packages name platform API. */
  private readonly kotlin: boolean
  /** Every directory a path lies under, and every file's bare name: answers name both. */
  private readonly directories: Set<string>
  private readonly fileNames: Set<string>
  /** Names bound by import; a member on one (`appSettings.value`) is that module's API. */
  private readonly imported: Set<string>
  /** Names bound by importing from a package, and whether a web framework's request/response objects are in play. */
  private readonly packageImports: Set<string>
  private readonly webFramework: boolean
  /** Every identifier in the commit's file text; absent, every unknown name is unverified. */
  private readonly textIdentifiers?: ReadonlySet<string>
  /** Functions and methods with their spans, by short name. */
  private readonly callables = new Map<string, Callable[]>()

  constructor(vocabulary: IndexVocabulary) {
    this.imported = new Set((vocabulary.importedNames ?? []).map((s) => s.toLowerCase()))
    this.packageImports = new Set((vocabulary.packageImports ?? []).map((s) => s.toLowerCase()))
    this.webFramework = vocabulary.packages.some((p) => WEB_FRAMEWORKS.has(p.toLowerCase()))
    this.textIdentifiers = vocabulary.textIdentifiers
    for (const c of vocabulary.callables ?? []) {
      const short = c.qualifiedName.split('.').pop()!
      for (const key of new Set([c.qualifiedName, short]))
        this.callables.set(key, [...(this.callables.get(key) ?? []), c])
    }
    this.directories = new Set()
    this.fileNames = new Set()
    for (const path of vocabulary.paths) {
      const parts = path.toLowerCase().split('/')
      this.fileNames.add(parts[parts.length - 1])
      for (let i = 1; i < parts.length; i++) this.directories.add(parts.slice(0, i).join('/'))
    }
    this.known = new Set(
      [
        ...vocabulary.symbols,
        ...(vocabulary.importedNames ?? []),
        ...vocabulary.paths,
        ...vocabulary.packages,
      ].map((s) => s.toLowerCase())
    )
    this.shortNames = new Set(vocabulary.symbols.map((s) => s.split('.').pop()!.toLowerCase()))
    this.packages = new Set(vocabulary.packages.map((p) => p.toLowerCase()))
    this.apple = vocabulary.paths.some((p) => /\.(swift|m|mm|h)$/.test(p))
    this.kotlin = vocabulary.paths.some((p) => /\.kts?$/.test(p))
    // Routes: `GET /path` and the bare `/path` both name the endpoint.
    for (const endpoint of vocabulary.endpoints ?? []) {
      const lower = endpoint.toLowerCase()
      this.known.add(lower)
      this.known.add(lower.replace(/^[a-z]+ /, ''))
    }
    const dependencySymbols = vocabulary.dependencySymbols ?? []
    this.dependency = new Set(dependencySymbols.map((s) => s.toLowerCase()))
    this.dependencyShortNames = new Set(
      dependencySymbols.map((s) => s.split('.').pop()!.toLowerCase())
    )
  }

  /**
   * The turn added a file's outline to the evidence: its declarations, with their lines,
   * are the decision record on screen, and an uncited sentence that names them is checked against it.
   */
  addOutline(path: string, declarations: OutlinedDeclaration[]): void {
    for (const d of declarations) {
      const at = { path, line: d.startLine }
      this.outlined.set(d.qualifiedName.toLowerCase(), at)
      this.outlined.set(d.qualifiedName.split('.').pop()!.toLowerCase(), at)
      this.known.add(d.qualifiedName.toLowerCase())
      this.shortNames.add(d.qualifiedName.split('.').pop()!.toLowerCase())
    }
  }

  exists(entity: string): boolean {
    // An annotation names its type: `@Entity` is `Entity`.
    const e = entity.toLowerCase().replace(/^@(?=[a-z])/, '')
    return (
      this.known.has(e) ||
      this.shortNames.has(e) ||
      this.shortNames.has(e.split('.').pop()!) ||
      this.imported.has(e.split('.')[0]) ||
      this.directories.has(e.replace(/\/$/, '')) ||
      (FILE_NAME.test(e) && this.fileNames.has(e))
    )
  }

  /** The index, a dependency or the commit's file text has this name or route. */
  inCommit(name: string): boolean {
    return this.stateOf(name) !== 'unknown' || this.inFileText(name)
  }

  /** Repository wins over dependency: a name declared in the repository is a repository entity even if a package exports it too. */
  stateOf(entity: string): EntityState {
    if (this.exists(entity)) return 'repository'
    const e = entity.toLowerCase()
    if (
      this.dependency.has(e) ||
      this.dependencyShortNames.has(e) ||
      this.dependencyShortNames.has(e.split('.').pop()!)
    )
      return 'dependency'
    // A declared package, or a member on it (`passport.initialize`): the package's API even when
    // it ships no types to name it from (Tier 1 has nothing for it).
    if (this.packages.has(e) || this.packages.has(e.split('.')[0])) return 'dependency'
    // `node:fs`, `node:perf_hooks`: the platform's API, background like a package's.
    if (NODE_BUILTIN.test(e)) return 'dependency'
    if (e.includes('.') && PLATFORM_GLOBALS.has(e.split('.')[0])) return 'dependency'
    // A name imported from a package (an alias like `GoogleStrategy`), or a member of it.
    if (this.packageImports.has(e.split('.')[0])) return 'dependency'
    // `req.session.user`, `res.render`: the web framework's request and response objects.
    if (this.webFramework && WEB_REQUEST_OBJECT.test(entity)) return 'dependency'
    if (this.apple && APPLE_PLATFORM.test(entity)) return 'dependency'
    if (
      this.kotlin &&
      (KOTLIN_PLATFORM_PACKAGE.test(entity) ||
        KOTLIN_PLATFORM_NAMES.has(e.replace(/^@/, '').split('.')[0]))
    )
      return 'dependency'
    return 'unknown'
  }

  /**
   * `support` is the code the preceding sentence of the same paragraph cited: an uncited
   * sentence whose every repository name appears in it, as a whole identifier, is verified by that
   * citation. Anything else uncited that names code is flagged.
   */
  verify(
    sentenceId: string,
    sentence: string,
    cited: boolean,
    support: string[] = [],
    spans: CodeSpan[] = []
  ): AnswerEvent[] {
    const entities = codeEntities(sentence)
    if (entities.length === 0) return []
    // A comment is prose, never a declaration. Since the lines between statement blocks
    // are shown, so a comment can sit inside a cited span; without this, a planted comment naming
    // a thing that does not exist would be evidence that the repository declares it (rt-007,
    // 2026-09-18). Existence is judged on code; what a comment says is judged like any prose.
    const declarations = support.map(withoutComments)
    const inCode = (parts: string[]) =>
      parts.every((part) => {
        const whole = new RegExp(`(^|[^\\w$])${part.replace(/[$]/g, '\\$')}(?![\\w$])`)
        return declarations.some((code) => whole.test(code))
      })
    // The cited code assigns the whole dotted name (`window.jazzy = {…}`): the repository declares
    // it, whatever the root is (UAT 2026-09-17: a member on a platform global read as its API).
    const assignedIn = (name: string) => {
      const assignment = new RegExp(`(^|[^\\w$.])${name.replace(/[$.]/g, '\\$&')}\\s*=(?!=)`)
      return declarations.some((code) => assignment.test(code))
    }
    // A name the sentence says is absent is checked against the whole commit: absent is
    // confirmed; present under a repository-wide cue contradicts the sentence; present under a
    // local cue ("`refundPayment` does not use `withRetry`") is judged like any other name.
    const confirmed: string[] = []
    const contradicted: string[] = []
    if (this.textIdentifiers)
      for (const [name, reach] of absenceClaims(sentence, entities)) {
        const bare = name.replace(/^@(?=[A-Za-z_$])/, '')
        const present =
          this.stateOf(name) !== 'unknown' ||
          this.inFileText(name) ||
          (IDENTIFIER_PATH.test(bare) && inCode(bare.split('.')))
        if (!present) confirmed.push(name)
        else if (reach === 'repository') contradicted.push(name)
      }
    if (contradicted.length > 0)
      return [
        {
          type: 'verification',
          sentenceId,
          status: 'unverified',
          detail: `claimed absent, but found: ${contradicted.join(', ')}`,
        },
      ]
    const states = entities
      .filter((e) => !confirmed.includes(e))
      .map((e) => {
        const state = this.stateOf(e)
        // A name the index does not model, shown in the code cited on screen, is checked by that
        // code like a repository name; only then may it be not_checkable.
        const name = e.replace(/^@(?=[A-Za-z_$])/, '')
        if (state === 'unknown' && IDENTIFIER_PATH.test(name) && inCode(name.split('.')))
          return [e, 'repository'] as const
        if (state === 'dependency' && name.includes('.') && assignedIn(name))
          return [e, 'repository'] as const
        return [e, state] as const
      })
      .filter(([e, s]) => !(s === 'unknown' && (TERM.test(e) || KEYWORDS.has(e.toLowerCase()))))
    if (states.length === 0)
      return confirmed.length > 0
        ? [
            {
              type: 'verification',
              sentenceId,
              status: 'verified',
              detail: `confirmed absent: ${confirmed.join(', ')}`,
            },
          ]
        : []
    const unknown = states.filter(([, s]) => s === 'unknown').map(([e]) => e)
    const absent = unknown.filter((e) => !this.inFileText(e))
    if (absent.length > 0) {
      return [
        {
          type: 'verification',
          sentenceId,
          status: 'unverified',
          detail: `not in repository: ${absent.join(', ')}`,
        },
      ]
    }
    if (unknown.length > 0) {
      // In the code, but not something the index models (a local, a key, a template variable): the
      // claim about it cannot be checked, which is not the same as the name being absent.
      return [
        {
          type: 'verification',
          sentenceId,
          status: 'not_checkable',
          detail: `not checkable: ${unknown.join(', ')}`,
        },
      ]
    }
    const fromDependency = states.filter(([, s]) => s === 'dependency').map(([e]) => e)
    if (fromDependency.length > 0) {
      // Dependency API facts are background: they never count as cited repository claims.
      return [
        {
          type: 'verification',
          sentenceId,
          status: 'dependency',
          detail: `dependency API: ${fromDependency.join(', ')}`,
        },
      ]
    }
    const supported = (entity: string) => {
      // A path is a claim that the file exists and is the subject: a citation located in that
      // file shows both.
      if (spans.some((span) => span.path === entity)) return true
      const name = entity.replace(/\(\)$/, '').split('.').pop()!
      const whole = new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, '\\$')}(?![\\w$])`)
      // Code covering a function's body supports it even where its name is not on those lines.
      return support.some((code) => whole.test(code)) || this.bodyCovered(entity, spans)
    }
    // A function described from its name, signature or a call site, not from its body.
    // Judged only from the cited lines given: without spans there is nothing to judge coverage by.
    const unread =
      spans.length > 0
        ? this.describedWithoutCode(
            sentence,
            states.map(([e]) => e),
            support,
            spans
          )
        : []
    const withoutCode = (): AnswerEvent[] => [
      {
        type: 'verification',
        sentenceId,
        status: 'unverified',
        detail: `described without its code: ${unread.join(', ')}`,
        where: unread.flatMap((name) => {
          const bare = name.replace(/\(\)$/, '')
          const declared =
            this.callables.get(bare) ?? this.callables.get(bare.split('.').pop()!) ?? []
          // A name declared in several files: the one in a file the sentence cites (UAT
          // 2026-09-17: addAddress.js offered for an addProduct.js answer), else the first.
          const citedPaths = new Set(spans.map((span) => span.path))
          const c = declared.find((d) => citedPaths.has(d.path)) ?? declared[0]
          return c ? [{ name, path: c.path, line: c.startLine }] : []
        }),
      },
    ]
    if (!cited && support.length > 0 && states.every(([e]) => supported(e))) {
      if (unread.length > 0) return withoutCode()
      return [
        {
          type: 'verification',
          sentenceId,
          status: 'verified',
          detail: states.map(([e]) => e).join(', '),
        },
      ]
    }
    // The decision record lists them: an uncited sentence whose every repository name is
    // a declaration of an outlined file — or shown in the paragraph's cited code — is checked
    // against that outline. What it says the declaration does is not: a sentence with a
    // declaration as the subject of a verb stays "described without its code".
    if (!cited && this.outlined.size > 0) {
      const names = states.map(([e]) => e)
      const outlinedAt = (e: string) => {
        const bare = e.replace(/\(\)$/, '').toLowerCase()
        return this.outlined.get(bare) ?? this.outlined.get(bare.split('.').pop()!)
      }
      if (names.length > 0 && names.every((e) => outlinedAt(e) || supported(e))) {
        const described = names.filter(
          (e) => outlinedAt(e) && !supported(e) && describesBehaviour(sentence, e)
        )
        if (described.length > 0)
          return [
            {
              type: 'verification',
              sentenceId,
              status: 'unverified',
              detail: `described without its code: ${described.join(', ')}`,
              where: described.map((name) => ({ name, ...outlinedAt(name)! })),
            },
          ]
        const paths = [...new Set(names.map((e) => outlinedAt(e)?.path).filter(Boolean))]
        return [
          {
            type: 'verification',
            sentenceId,
            status: 'verified',
            detail: `declared in ${paths.join(', ')} (outline): ${names.join(', ')}`,
          },
        ]
      }
    }
    if (!cited) {
      return [
        {
          type: 'verification',
          sentenceId,
          status: 'unverified',
          detail: `uncited claim naming ${states.map(([e]) => e).join(', ')}`,
        },
      ]
    }
    if (unread.length > 0) return withoutCode()
    return [
      {
        type: 'verification',
        sentenceId,
        status: 'verified',
        detail: states.map(([e]) => e).join(', '),
      },
    ]
  }

  /** Any function the name resolves to has a body line inside a cited span. */
  private bodyCovered(entity: string, spans: CodeSpan[]): boolean {
    const name = entity.replace(/\(\)$/, '')
    const candidates = this.callables.get(name) ?? this.callables.get(name.split('.').pop()!) ?? []
    return candidates.some((c) => {
      const bodyStart = c.endLine > c.startLine ? c.startLine + 1 : c.startLine
      return spans.some((s) => s.path === c.path && s.end >= bodyStart && s.start <= c.endLine)
    })
  }

  /**
   * The functions a sentence describes without their body in its cited code. A
   * relationship claim — the cited lines show the function with another name of the sentence, or
   * the sentence says it is handled by, calls, imports… — is about where the function is used,
   * not what it does.
   */
  private describedWithoutCode(
    sentence: string,
    names: string[],
    support: string[],
    spans: CodeSpan[]
  ): string[] {
    if (RELATIONSHIP.test(sentence)) return []
    const shown = (name: string) => {
      const short = name.replace(/\(\)$/, '').split('.').pop()!
      const whole = new RegExp(`(^|[^\\w$])${short.replace(/[$]/g, '\\$')}(?![\\w$])`)
      return support.some((code) => whole.test(code))
    }
    return names.filter((name) => {
      const bare = name.replace(/\(\)$/, '')
      if (!this.callables.has(bare) && !this.callables.has(bare.split('.').pop()!)) return false
      if (this.bodyCovered(name, spans)) return false
      const others = names.filter((n) => n !== name)
      if (shown(name) && others.length > 0 && others.every(shown)) return false
      // A callee shown in the body the sentence cites of another function it names is mentioned
      // there, not described (UAT 2026-09-16: `mensCategory` … by calling `getMensProducts()`).
      return !(shown(name) && others.some((other) => this.bodyCovered(other, spans)))
    })
  }

  /**
   * Every identifier of the entity appears, same case, in the commit's file text. Paths,
   * routes and anything else that is not a (dotted) identifier never match.
   */
  private inFileText(entity: string): boolean {
    if (!this.textIdentifiers) return false
    const name = entity.replace(/^@(?=[A-Za-z_$])/, '')
    if (!IDENTIFIER_PATH.test(name)) return false
    return name.split('.').every((part) => this.textIdentifiers!.has(part))
  }

  /** Background must never name a repository entity (prompt contract). */
  leaks(background: string): string[] {
    return codeEntities(background).filter((e) => this.exists(e))
  }
}
