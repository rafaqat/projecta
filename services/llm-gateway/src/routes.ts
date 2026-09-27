import type { GatewayPolicy } from './policy.js'

/**
 * Residency route table: the app always sends the same request;
 * the route decides the upstream host, path prefix and credential. Foundry
 * rewrites only those three things and authenticates with a bearer token
 * from the configured provider (managed identity on Azure).
 */
export interface Upstream {
  name: 'anthropic' | 'foundry'
  baseUrl: string
  pathPrefix: string
  headers(): Promise<Record<string, string>>
}

export interface RouteConfig {
  anthropic: { baseUrl: string; apiKey: string }
  foundry?: { baseUrl: string; token: () => Promise<string> }
}

export function routeFor(policy: GatewayPolicy, workspace: string, config: RouteConfig): Upstream {
  const name = policy.routes.workspaces[workspace] ?? policy.routes.default
  if (name === 'foundry') {
    if (!config.foundry) throw new Error('foundry route selected but not configured')
    const foundry = config.foundry
    return {
      name,
      baseUrl: foundry.baseUrl.replace(/\/$/, ''),
      pathPrefix: '/anthropic',
      headers: async () => ({ authorization: `Bearer ${await foundry.token()}` }),
    }
  }
  return {
    name: 'anthropic',
    baseUrl: config.anthropic.baseUrl.replace(/\/$/, ''),
    pathPrefix: '',
    headers: async () => ({ 'x-api-key': config.anthropic.apiKey }),
  }
}
