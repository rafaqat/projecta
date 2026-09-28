/**
 * What a failed model call is, reduced to closed sets.
 *
 * The collector's allowlist (SEC-14, ADR-023) carries `app.error.code` and drops the message, so the
 * code is the whole of what an operator reads in a dashboard. Deriving it from `error.name` made every
 * failure the same: no error class in `@anthropic-ai/sdk` assigns `name`, so a connection failure, a
 * timeout, a 429 and a 500 all arrived as `E_MODEL_Error` (UAT 2026-09-16; again 2026-09-27 22:54 UTC,
 * when a turn met the gateway mid-restart). The constructor names the class, and the operating
 * system's errno rides along as the cause.
 *
 * Neither field is free text. The class name is the SDK's own vocabulary and the errno is libuv's, so
 * both are safe to carry where a message is not.
 */
export interface ModelErrorFacts {
  /** `E_<CODE>` when the error carried one, else `E_MODEL_<ClassName>`. */
  code: string
  /** The errno underneath, when a transport error wrapped one: `EAI_AGAIN`, `ECONNREFUSED`, ... */
  cause?: string
  /** The provider's HTTP status, when the failure reached one. */
  status?: number
}

/** An errno is upper-case letters and digits; anything else is not one, and is not carried. */
const ERRNO = /^[A-Z][A-Z0-9_]{2,31}$/

/** The class the error was constructed as, which is what `name` would say if the SDK set it. */
function className(error: unknown): string {
  const ctor = (error as { constructor?: { name?: unknown } }).constructor
  if (typeof ctor?.name === 'string' && ctor.name && ctor.name !== 'Object') return ctor.name
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' && name ? name : 'ERROR'
}

/**
 * The errno a transport error wrapped. Node puts it on the error it threw, and an SDK wraps that as
 * `cause`, so the chain is walked rather than the top frame read. Bounded: a cause cycle must not
 * hang the reporter.
 */
function errnoOf(error: unknown): string | undefined {
  let current = error
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && ERRNO.test(code)) return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * The run's status line. The reader of the console gets the same code the dashboard shows, so a run
 * handle and a Loki query name the same failure without opening the trace.
 */
export function modelErrorLabel(facts: ModelErrorFacts): string {
  return `model error: ${facts.code}${facts.cause ? ` (${facts.cause})` : ''}`
}

export function classifyModelError(error: unknown): ModelErrorFacts {
  const own = (error as { code?: unknown }).code
  const errno = errnoOf(error)
  const status = (error as { status?: unknown }).status
  // An `E_`-prefixed code is the application's own and names the failure better than the class does.
  const code = typeof own === 'string' && own.startsWith('E_') ? own : `E_MODEL_${className(error)}`
  return {
    code,
    ...(errno && errno !== own ? { cause: errno } : {}),
    ...(typeof status === 'number' ? { status } : {}),
  }
}
