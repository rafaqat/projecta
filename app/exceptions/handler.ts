import { createHash, randomBytes } from 'node:crypto'
import app from '@adonisjs/core/services/app'
import { type HttpContext, ExceptionHandler } from '@adonisjs/core/http'
import type { StatusPageRange, StatusPageRenderer } from '@adonisjs/core/types/http'
import env from '#start/env'
import { securityEvents } from '#app/security/events/index'
import { cspDirectivesFor, cspHeaderFor, VITE_DEV_ORIGIN } from '#app/security/headers'

const PRODUCTION_ENVS = ['uat', 'production']

/**
 * Global exception policy (SEC-39). Outside local development a
 * user-facing error carries a correlation ID and nothing else: no message,
 * no stack, no framework detail. The full error is logged server-side with
 * the same ID so support can join the two. Authorisation and policy errors
 * deny by default because they reach this handler as exceptions.
 */
export default class HttpExceptionHandler extends ExceptionHandler {
  protected productionMode = PRODUCTION_ENVS.includes(env.get('APP_ENV'))

  protected debug = !app.inProduction

  protected renderStatusPages = app.inProduction

  protected statusPages: Record<StatusPageRange, StatusPageRenderer> = {
    '404': (_, ctx) => this.renderPage(ctx, 'errors/not_found', {}),
    '500..599': (_, ctx) =>
      this.renderPage(ctx, 'errors/server_error', { correlationId: ctx.request.id() }),
  }

  async handle(error: unknown, ctx: HttpContext) {
    const status = this.statusOf(error)
    const wantsHtml = ctx.request.accepts(['html', 'json']) === 'html' && 'inertia' in ctx

    // Unmatched routes never reach Shield; the not-found page is ours in every environment.
    if (status === 404 && wantsHtml) {
      return ctx.response.status(404).send(await this.renderPage(ctx, 'errors/not_found', {}))
    }
    if (!this.productionMode) return super.handle(error, ctx)

    const correlationId = ctx.request.id() ?? crypto.randomUUID()
    ctx.response.header('x-request-id', correlationId)
    ctx.response.status(status)

    if (status < 500) return super.handle(error, ctx)
    if (wantsHtml)
      return ctx.response.send(await this.renderPage(ctx, 'errors/server_error', { correlationId }))
    return ctx.response.send({ correlationId })
  }

  /**
   * Error pages render outside the router middleware chain, so the CSP
   * Shield would have set is applied here with a fresh nonce, shared with
   * the view exactly as Shield shares it.
   */
  private renderPage(
    ctx: HttpContext,
    page: 'errors/not_found' | 'errors/server_error',
    props: Record<string, unknown>
  ) {
    const nonce = randomBytes(16).toString('base64url')
    ctx.response.header(
      'content-security-policy',
      cspHeaderFor(cspDirectivesFor(env.get('APP_ENV'), VITE_DEV_ORIGIN), nonce)
    )
    if ('view' in ctx) ctx.view.share({ cspNonce: nonce })
    return ctx.inertia.render(page, props)
  }

  /**
   * Telemetry never carries exception messages: outside local
   * development the log line holds a code and a hash of the message only.
   */
  async report(error: unknown, ctx: HttpContext) {
    const status = this.statusOf(error)
    const errorCode = (error as { code?: string }).code ?? 'E_UNHANDLED'
    const requestId = ctx.request.id() ?? ''
    if (errorCode === 'E_AUTHORIZATION_FAILURE' || errorCode === 'E_UNAUTHORIZED_ACCESS') {
      securityEvents.emit('authz.denied', {
        policy: errorCode,
        resource: ctx.route?.pattern ?? '',
        requestId,
      })
    } else if (status >= 500) {
      const message = error instanceof Error ? error.message : String(error)
      const errorHash = createHash('sha256').update(message).digest('hex').slice(0, 16)
      securityEvents.emit('error.unhandled', { errorCode, errorHash, status, requestId })
    }
    if (!this.productionMode) return super.report(error, ctx)
    ctx.logger.error({ correlationId: requestId, errorCode, status })
  }

  private statusOf(error: unknown): number {
    const status = (error as { status?: unknown }).status
    return typeof status === 'number' && status >= 400 && status <= 599 ? status : 500
  }
}
