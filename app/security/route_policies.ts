/**
 * Default-deny for resource routes (SEC-22). A route is a resource
 * route when its pattern names a workspace or repository handle; every such
 * route must carry the `authorize` middleware. The same predicate drives the
 * runtime guard, the coverage test and the IDOR matrix generator.
 */
export const RESOURCE_PARAMS = ['workspace', 'repository'] as const
export const FORBIDDEN_PARAMS = ['id', 'sha', 'blobSha', 'blob_sha']
export const AUTHORIZE_MIDDLEWARE = 'authorize'

export interface RouteShape {
  pattern: string
  methods: string[]
  middlewareNames: string[]
}

export function routeParams(pattern: string): string[] {
  return Array.from(pattern.matchAll(/:([A-Za-z_]+)\??/g), (m) => m[1])
}

export function isResourceRoute(pattern: string): boolean {
  return routeParams(pattern).some((p) => (RESOURCE_PARAMS as readonly string[]).includes(p))
}

export function findUnguardedRoutes(routes: RouteShape[]): RouteShape[] {
  return routes.filter(
    (r) => isResourceRoute(r.pattern) && !r.middlewareNames.includes(AUTHORIZE_MIDDLEWARE)
  )
}

/** INV-10: no route parameter may be a bare database ID or SHA. */
export function findForbiddenParams(
  routes: RouteShape[]
): Array<{ pattern: string; param: string }> {
  const findings: Array<{ pattern: string; param: string }> = []
  for (const route of routes) {
    for (const param of routeParams(route.pattern)) {
      if (FORBIDDEN_PARAMS.includes(param)) findings.push({ pattern: route.pattern, param })
    }
  }
  return findings
}
