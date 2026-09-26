/**
 * What the gateway did, reported on every response (ADR-070). The gateway decides more about a
 * turn's safety than anything else and said none of it unless it refused; everything it knew
 * lived in its own logs, where the reader cannot look and the engineer needs shell access to the
 * container.
 *
 * Decisions, never contents: rule ids, counts and pass or fail. Never the text that matched, the
 * allowlist's contents, or the workspace owning a honeytoken — that names another tenant and
 * belongs only in the P1 event. The summary is diagnostic: the gateway enforces, the application
 * records what it was told, and no application logic may branch on it.
 */
export type CheckOutcome = 'pass' | 'fail' | 'skipped'

export interface InboundDecisions {
  attribution: CheckOutcome
  model: CheckOutcome
  configHash: CheckOutcome
  prompt: CheckOutcome
  tools: CheckOutcome
  /** Inbound rule ids that fired, e.g. `inbound.secret`, `inbound.block_type:image`. */
  rules: string[]
  /** How many personal-data spans were masked; never what they were. */
  masked: number
  injectionSuspected: boolean
  detector: string
  detectorFailed: boolean
}

export interface OutboundDecisions {
  /** Rule ids evaluated over the answer, whether or not any fired. */
  rules: string[]
  /** The rule that ended the stream, or null when the answer was released whole. */
  blockedBy: string | null
  /** Characters of hold-back: the guarantee that no complete match was released unseen. */
  window: number
  /** How many external links were masked in the answer (ADR-0007); the app renders a notice when > 0. */
  masked?: number
}

export interface GatewayDecisions {
  v: 1
  inbound: InboundDecisions
  /** Absent until the answer has finished: it is not known when the response starts. */
  outbound?: OutboundDecisions
}

export const DECISIONS_HEADER = 'x-gateway-decisions'
/** The SSE event carrying the outbound half, last on the stream (ADR-070; the SDK ignores it). */
export const DECISIONS_EVENT = 'gateway_decisions'

export function emptyInbound(): InboundDecisions {
  return {
    attribution: 'skipped',
    model: 'skipped',
    configHash: 'skipped',
    prompt: 'skipped',
    tools: 'skipped',
    rules: [],
    masked: 0,
    injectionSuspected: false,
    detector: 'none',
    detectorFailed: false,
  }
}

/** Base64url so the summary is a legal header value whatever a rule id contains. */
export function encodeDecisions(decisions: GatewayDecisions): string {
  return Buffer.from(JSON.stringify(decisions), 'utf8').toString('base64url')
}

/** Null for anything that is not a summary this version understands: a reader never throws. */
export function decodeDecisions(value: string | null | undefined): GatewayDecisions | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as GatewayDecisions
    return parsed && parsed.v === 1 && parsed.inbound ? parsed : null
  } catch {
    return null
  }
}

/** The final frame of a stream, carrying the outbound half. */
export function decisionsFrame(decisions: GatewayDecisions): string {
  return `event: ${DECISIONS_EVENT}\ndata: ${JSON.stringify(decisions)}\n\n`
}
