import { defineConfig } from '@adonisjs/shield'
import env from '#start/env'
import { cspDirectivesFor, hstsEnabledFor, VITE_DEV_ORIGIN } from '#app/security/headers'

/**
 * Values come from app/security/headers.ts so tests assert the same source
 * the middleware reads (SEC-34).
 */
const shieldConfig = defineConfig({
  csp: {
    enabled: true,
    directives: cspDirectivesFor(env.get('APP_ENV'), VITE_DEV_ORIGIN),
    reportOnly: false,
  },

  csrf: {
    enabled: true,
    exceptRoutes: ['/webhooks/github/:hook'],
    enableXsrfCookie: true,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
  },

  xFrame: {
    enabled: true,
    action: 'DENY',
  },

  hsts: {
    enabled: hstsEnabledFor(env.get('APP_ENV')),
    maxAge: '180 days',
  },

  contentTypeSniffing: {
    enabled: true,
  },
})

export default shieldConfig
