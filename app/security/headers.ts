/**
 * HTTP security header baseline (SEC-34). Shield emits the CSP,
 * HSTS, X-Frame-Options and nosniff headers from this module's values; the
 * remaining headers are set by `SecurityHeadersMiddleware` on every response.
 */
export type AppEnv = 'local' | 'test' | 'uat' | 'production'

const ENVS_WITH_HSTS: AppEnv[] = ['uat', 'production']

export function hstsEnabledFor(appEnv: string): boolean {
  return ENVS_WITH_HSTS.includes(appEnv as AppEnv)
}

/** Vite's dev server serves scripts and HMR sockets from its own origin; only local and test run it. */
const ENVS_WITH_DEV_BUNDLER: AppEnv[] = ['local', 'test']
export const VITE_DEV_ORIGIN = 'http://localhost:5173'

export function cspDirectivesFor(appEnv: string, viteDevOrigin?: string) {
  const dev =
    ENVS_WITH_DEV_BUNDLER.includes(appEnv as AppEnv) && viteDevOrigin ? [viteDevOrigin] : []
  // The dev bundler's HMR socket uses an ephemeral localhost port.
  const devWs = dev.length ? ['ws://localhost:*', 'ws://127.0.0.1:*'] : []
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", '@nonce', ...dev],
    styleSrc: ["'self'", '@nonce', ...dev],
    imgSrc: ["'self'", 'data:'],
    fontSrc: ["'self'"],
    connectSrc: ["'self'", ...dev, ...devWs],
    objectSrc: ["'none'"],
    baseUri: ["'none'"],
    frameAncestors: ["'none'"],
    formAction: ["'self'"],
  }
}

export const staticSecurityHeaders: Record<string, string> = {
  'Referrer-Policy': 'no-referrer',
  // The application embeds nothing cross-origin and is embedded by nothing.
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'X-Content-Type-Options': 'nosniff',
}

/**
 * The CSP header for a response Shield never saw. Shield is router
 * middleware, so an unmatched route (404) or an error rendered by the
 * exception handler would otherwise ship HTML without the policy. The
 * directives are the same source Shield reads; `@nonce` becomes the nonce
 * the caller shares with the view.
 */
export function cspHeaderFor(
  directives: ReturnType<typeof cspDirectivesFor>,
  nonce: string
): string {
  return Object.entries(directives)
    .map(([name, values]) => {
      const directive = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
      return `${directive} ${values.map((v) => (v === '@nonce' ? `'nonce-${nonce}'` : v)).join(' ')}`
    })
    .join(';')
}
