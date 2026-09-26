import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { trace, type Span } from '@opentelemetry/api'
import {
  DECISIONS_HEADER,
  decisionsFrame,
  emptyInbound,
  encodeDecisions,
  HoldbackStream,
  PolicyViolation,
  canaryCandidates,
  canaryRule,
  checkInbound,
  honeytokenCandidates,
  parseFrames,
  rawHtmlRule,
  ruleDetector,
  secretRule,
  urlRule,
  verifyCanary,
  violationFrame,
  type AsyncOutputRule,
  type InjectionDetector,
  type GatewayDecisions,
  type InboundDecisions,
  type MessagesBody,
  type OutputRule,
} from '../../../packages/guards/src/index.js'
import { AttributionError, ReplayCache, verifyAttribution } from './attribution.js'
import { type GatewayLedger } from './ledger.js'
import { promptHashOf, toolHashOf, type GatewayPolicy } from './policy.js'
import { routeFor, type RouteConfig } from './routes.js'

/**
 * The gateway request path (design §10). Order: attribution →
 * allowlists (model, configHash, prompt hash, tool hash, block shapes) →
 * inbound guards → route → upstream with stripped headers → hold-back
 * outbound rules → ledger. Every decision lands on the span as
 * app.policy.decision / app.policy.rule. The webhook exposes the same
 * guards for other proxies.
 */
export interface GatewayOptions {
  policy: GatewayPolicy
  policyHash: string
  routes: RouteConfig
  ledger: GatewayLedger
  detector?: InjectionDetector | null
  /** Key for the compliance canary; absent, the rule never fires. */
  canaryKey?: string
  onEvent?: (event: string, fields: Record<string, unknown>) => void
  fetch?: typeof fetch
  /** Cap on any inbound request body; defaults to GATEWAY_MAX_BODY_BYTES or 10 MiB. */
  maxBodyBytes?: number
}

const STRIPPED = new Set([
  'host',
  'connection',
  'content-length',
  'x-api-key',
  'authorization',
  'traceparent',
  'tracestate',
  'baggage',
  'x-attribution',
  'x-config-hash',
  'cookie',
])

/**
 * A rejection says which check failed. The summary reaches a caller that never
 * authenticated, which is why it carries outcomes and rule ids and never the request's contents.
 */
function deny(
  res: ServerResponse,
  status: number,
  code: string,
  span?: Span,
  inbound?: InboundDecisions
) {
  span?.setAttribute('app.policy.decision', 'reject')
  span?.setAttribute('app.policy.rule', code)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (inbound) headers[DECISIONS_HEADER] = encodeDecisions({ v: 1, inbound })
  res.writeHead(status, headers)
  res.end(JSON.stringify({ type: 'error', error: { type: code } }))
}

/** A request body larger than the cap: readBody stops reading and the handler answers 413. */
class PayloadTooLargeError extends Error {}

/** Default cap on any inbound request body (Messages API and both guard endpoints); see GatewayOptions.maxBodyBytes. */
const MAX_BODY_BYTES = Number(process.env.GATEWAY_MAX_BODY_BYTES ?? 10 * 1024 * 1024)

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    // Enforce during the read, not on a (spoofable, absent) content-length: memory is bounded because
    // we stop accumulating here — the handler then answers 413 and ends the response, which closes the
    // socket. Destroying the request socket ourselves would race that write and strand the client.
    if (total > maxBytes) throw new PayloadTooLargeError()
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const body = await readBody(req, maxBytes)
  return JSON.parse(body.toString('utf8') || '{}')
}

export function createGateway(options: GatewayOptions): Server {
  const { policy, ledger } = options
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES
  const replay = new ReplayCache()
  const doFetch = options.fetch ?? fetch
  const tracer = trace.getTracer('llm-gateway')
  const emit = (event: string, fields: Record<string, unknown>) => options.onEvent?.(event, fields)
  emit('policy.loaded', { hash: options.policyHash, version: policy.version })

  const outputRules = (workspace: string): Array<OutputRule | AsyncOutputRule> => [
    canaryRule(policy.canaries),
    secretRule(),
    urlRule(policy.allowedUrlHosts),
    rawHtmlRule(),
    {
      // The compliance canary: the app puts an instruction in the evidence of a sampled
      // turn and this fires only if the model followed it. Not a breach — the product being asked
      // to do something it should not, and stopped — so it is a rate to watch, not a page.
      id: 'output.compliance_canary',
      maxMatchLength: 30,
      assert(text: string) {
        for (const candidate of canaryCandidates(text)) {
          if (!verifyCanary(candidate, options.canaryKey ?? '')) continue
          emit('canary.followed', { workspace, severity: 'watch' })
          throw new PolicyViolation('output.compliance_canary', 'high')
        }
      },
    },
    {
      id: 'output.honeytoken',
      maxMatchLength: 27,
      async assert(text: string) {
        for (const candidate of honeytokenCandidates(text)) {
          const owner = await ledger.honeytokenOwner(candidate)
          if (owner && owner.workspaceId !== workspace) {
            emit('honeytoken.foreign', { workspace, owner: owner.workspaceId, severity: 'P1' })
            throw new PolicyViolation('output.honeytoken', 'critical')
          }
        }
      },
    },
  ]

  async function messages(req: IncomingMessage, res: ServerResponse, span: Span) {
    let raw: Buffer
    try {
      raw = await readBody(req, maxBodyBytes)
    } catch (error) {
      if (error instanceof PayloadTooLargeError) return deny(res, 413, 'request_too_large', span)
      throw error
    }
    let body: MessagesBody & { metadata?: unknown }
    try {
      body = JSON.parse(raw.toString('utf8')) as MessagesBody
    } catch {
      return deny(res, 400, 'invalid_request_error', span)
    }
    // What this request was checked for, filled in as each check runs.
    const decisions = emptyInbound()
    let who
    try {
      who = await verifyAttribution(req.headers['x-attribution']?.toString(), body, policy, replay)
      decisions.attribution = 'pass'
    } catch (error) {
      const reason = error instanceof AttributionError ? error.reason : 'invalid'
      decisions.attribution = 'fail'
      emit('policy.enforced', { rule: `attribution.${reason}`, decision: 'reject' })
      return deny(res, 401, `attribution_${reason}`, span, decisions)
    }
    span.setAttribute('user.id', who.sub)
    span.setAttribute('app.workspace.id', who.workspace)
    const configHash = req.headers['x-config-hash']?.toString() ?? ''
    const checks: Array<[boolean, string, keyof InboundDecisions]> = [
      [!policy.models.includes(String(body.model)), 'model_not_allowed', 'model'],
      [!policy.configHashes.includes(configHash), 'config_hash_unvalidated', 'configHash'],
      [
        !policy.promptHashes.includes(promptHashOf(body.system) ?? ''),
        'prompt_hash_unapproved',
        'prompt',
      ],
      [
        !policy.toolDefinitionHashes.includes(toolHashOf(body.tools)),
        'tool_definitions_unapproved',
        'tools',
      ],
    ]
    for (const [failed, rule, name] of checks) {
      ;(decisions[name] as string) = failed ? 'fail' : 'pass'
      if (failed) {
        emit('policy.enforced', { rule: `allowlist.${rule}`, decision: 'reject', sub: who.sub })
        return deny(res, 403, rule, span, decisions)
      }
    }
    let inbound
    try {
      inbound = await checkInbound(body, {
        detector: options.detector === null ? undefined : (options.detector ?? ruleDetector),
      })
    } catch {
      decisions.rules.push('inbound.rule_error')
      emit('policy.enforced', { rule: 'inbound.rule_error', decision: 'reject' })
      return deny(res, 403, 'inbound_rule_error', span, decisions) // fail closed on a rule exception
    }
    decisions.rules = inbound.reasons
    decisions.masked = inbound.masked
    decisions.injectionSuspected = inbound.annotations.injectionSuspected
    decisions.detector = inbound.annotations.detector
    decisions.detectorFailed = inbound.annotations.detectorFailed
    if (inbound.decision === 'reject') {
      emit('policy.enforced', { rule: inbound.reasons[0], decision: 'reject', sub: who.sub })
      return deny(res, 403, inbound.reasons[0].replace(/[:.]/g, '_'), span, decisions)
    }
    if (inbound.annotations.detectorFailed)
      emit('detector.unavailable', { detector: inbound.annotations.detector })
    span.setAttribute('app.injection.suspected', inbound.annotations.injectionSuspected)
    // Annotation only, but counted: the request still goes to the provider, and a
    // run of these from one workspace is a poisoned repository being asked about. Never the text.
    if (inbound.annotations.injectionSuspected)
      emit('injection.suspected', {
        workspace: who.workspace,
        sub: who.sub,
        detector: inbound.annotations.detector,
      })
    // Unknown block shapes are also rejected inside checkInbound; masking only changes the body when a rule fired.
    const forwardBody = inbound.masked > 0 ? Buffer.from(JSON.stringify(inbound.body)) : raw

    const upstream = routeFor(policy, who.workspace, options.routes)
    span.setAttribute('app.route', upstream.name)
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (STRIPPED.has(name) || value === undefined) continue
      headers.set(name, Array.isArray(value) ? value.join(', ') : value)
    }
    for (const [k, v] of Object.entries(await upstream.headers())) headers.set(k, v)
    headers.set('anthropic-version', req.headers['anthropic-version']?.toString() ?? '2023-06-01')
    const ledgerId = await ledger.open({ ...who, model: String(body.model), route: upstream.name })
    const controller = new AbortController()
    req.on('close', () => controller.abort())
    let response: Response
    try {
      response = await doFetch(`${upstream.baseUrl}${upstream.pathPrefix}${req.url}`, {
        method: 'POST',
        headers,
        body: new Uint8Array(forwardBody),
        signal: controller.signal,
      })
    } catch (error) {
      // Never swallowed: the class and code of the failure are logged and stamped on the span
      // (UAT 2026-09-16: four 0-second 502s with nothing to read). The message is not, since
      // an upstream error can echo request content.
      const cause = (error as { cause?: { code?: string; name?: string } }).cause
      const code = cause?.code ?? cause?.name ?? (error as Error).name ?? 'unknown'
      span.setAttribute('app.upstream.error', code)
      emit('upstream.fetch_failed', {
        code,
        aborted: controller.signal.aborted,
        route: upstream.name,
        bytes: forwardBody.byteLength,
      })
      await ledger.close(ledgerId, controller.signal.aborted ? 'cancelled' : 'failed')
      if (!res.headersSent) deny(res, 502, 'api_error', span)
      return
    }
    // fetch() decodes the body, so the encoding and length headers describe bytes that are not forwarded.
    const HOP_BY_HOP = ['content-length', 'content-encoding', 'transfer-encoding', 'connection']
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, name) => {
      if (!HOP_BY_HOP.includes(name)) responseHeaders[name] = value
    })
    responseHeaders[DECISIONS_HEADER] = encodeDecisions({ v: 1, inbound: decisions })
    res.writeHead(response.status, responseHeaders)
    if (!response.body) {
      await ledger.close(ledgerId, response.ok ? 'completed' : 'failed')
      return res.end()
    }
    const streaming = (response.headers.get('content-type') ?? '').includes('text/event-stream')
    const rules = outputRules(who.workspace)
    // enableMask = true (ADR-0007): the URL rule redacts external links instead of withholding the
    // whole answer; every other rule still withholds fail-closed.
    const holdback = new HoldbackStream(rules, 128, true, true)
    const usage: { input?: number; output?: number } = {}
    const decoder = new TextDecoder()
    let rest = ''
    let status: 'completed' | 'cancelled' | 'failed' | 'blocked' = 'completed'
    try {
      const nonStreamParts: Buffer[] = []
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        if (!streaming) {
          // Buffer the whole non-streaming body; it is inspected as one unit after the loop so the
          // output rules run even when the provider did not stream (defense in depth) — a
          // JSON body can still carry secrets, a foreign honeytoken, a blocked URL or a followed canary.
          nonStreamParts.push(Buffer.from(chunk))
          continue
        }
        const parsed = parseFrames(rest + decoder.decode(chunk, { stream: true }))
        rest = parsed.rest
        for (const frame of parsed.frames) noteUsage(frame.raw, usage)
        const release = await holdback.push(parsed.frames)
        if (release) res.write(release)
        if (holdback.violation) break
      }
      if (!streaming) {
        // One synthetic frame: `raw` is forwarded verbatim when clean, `text` is what the rules scan.
        // Nothing is written until end(), so a violation withholds the entire body (fail closed).
        const nonStreamBody = Buffer.concat(nonStreamParts).toString('utf8')
        const released =
          (await holdback.push([{ raw: nonStreamBody, text: nonStreamBody }])) +
          (await holdback.end())
        if (!holdback.violation) res.write(released)
      }
      if (streaming && !holdback.violation) {
        // A partial frame left at end of stream is forwarded as the provider sent it, unchanged.
        const tail = rest.trim()
          ? parseFrames(rest + '\n\n')
          : { frames: [] as ReturnType<typeof parseFrames>['frames'] }
        const release = (await holdback.push(tail.frames)) + (await holdback.end())
        if (release) res.write(release)
      }
      // The outbound half, after the last content and before the terminator: which
      // rules ran over the answer, which one ended it, and the hold-back window that guaranteed
      // no complete match went out unseen. Before the violation frame, so that frame stays the
      // last thing a blocked stream carries and nothing follows a block. The provider SDK passes
      // an event it has no case for straight through (client_gateway.spec.ts).
      if (streaming) {
        const summary: GatewayDecisions = {
          v: 1,
          inbound: decisions,
          outbound: {
            rules: rules.map((r) => r.id),
            blockedBy: holdback.violation?.ruleId ?? null,
            window: holdback.window,
            masked: holdback.masked,
          },
        }
        res.write(decisionsFrame(summary))
      }
      if (holdback.violation) {
        status = 'blocked'
        span.setAttribute('app.policy.decision', 'block')
        span.setAttribute('app.policy.rule', holdback.violation.ruleId)
        emit('policy.enforced', {
          rule: holdback.violation.ruleId,
          decision: 'block',
          sub: who.sub,
          severity: holdback.violation.severity,
        })
        res.write(violationFrame(holdback.violation))
      }
    } catch (error) {
      status = controller.signal.aborted ? 'cancelled' : 'failed'
      // The stream broke after the response began: named, never a silent `failed` ledger row.
      const cause = (error as { cause?: { code?: string; name?: string }; name?: string }).cause
      emit('upstream.stream_failed', {
        code: cause?.code ?? cause?.name ?? (error as Error).name ?? 'unknown',
        aborted: controller.signal.aborted,
        route: upstream.name,
      })
    } finally {
      await ledger.close(ledgerId, status, usage, holdback.violation?.ruleId)
      res.end()
    }
  }

  return createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"status":"ok"}')
    }
    void tracer.startActiveSpan(`gateway ${req.method} ${req.url?.split('?')[0]}`, async (span) => {
      try {
        if (req.method === 'POST' && req.url === '/v1/messages') await messages(req, res, span)
        else if (req.method === 'POST' && req.url === '/guards/output')
          await webhookOutput(req, res)
        else if (req.method === 'POST' && req.url === '/guards/inbound')
          await webhookInbound(req, res)
        else deny(res, 404, 'not_found_error', span)
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          if (!res.headersSent) deny(res, 413, 'request_too_large', span)
          else res.end()
        } else {
          emit('gateway.error', { code: (error as Error).name })
          if (!res.headersSent) deny(res, 500, 'api_error', span)
          else res.end()
        }
      } finally {
        span.end()
      }
    })
  })

  /** Webhook: the output rules as a decision service for other proxies. */
  async function webhookOutput(req: IncomingMessage, res: ServerResponse) {
    const { text, workspace } = (await readJson(req, maxBodyBytes)) as {
      text: string
      workspace?: string
    }
    const holdback = new HoldbackStream(outputRules(workspace ?? ''))
    await holdback.push([{ raw: '', text: String(text ?? '') }])
    await holdback.end()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify(
        holdback.violation
          ? { decision: 'block', rule: holdback.violation.ruleId }
          : { decision: 'allow' }
      )
    )
  }

  async function webhookInbound(req: IncomingMessage, res: ServerResponse) {
    const body = (await readJson(req, maxBodyBytes)) as MessagesBody
    const result = await checkInbound(body, {
      detector: options.detector === null ? undefined : (options.detector ?? ruleDetector),
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        decision: result.decision,
        reasons: result.reasons,
        masked: result.masked,
        annotations: result.annotations,
      })
    )
  }
}

function noteUsage(raw: string, usage: { input?: number; output?: number }) {
  const data = raw.split('\n').find((l) => l.startsWith('data: '))
  if (!data) return
  try {
    const e = JSON.parse(data.slice(6)) as {
      type?: string
      message?: { usage?: { input_tokens?: number } }
      usage?: { output_tokens?: number }
    }
    if (e.type === 'message_start' && e.message?.usage?.input_tokens !== undefined)
      usage.input = e.message.usage.input_tokens
    if (e.type === 'message_delta' && e.usage?.output_tokens !== undefined)
      usage.output = e.usage.output_tokens
  } catch {
    /* not JSON: nothing to note */
  }
}
