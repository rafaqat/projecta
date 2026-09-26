import { isResourceRoute, type RouteShape } from '#app/security/route_policies'

/**
 * IDOR matrix (SEC-22): every resource route, exercised as each
 * actor with identifiers they must not reach. Generated from the router so
 * a new route is covered the day it is added. Expected outcome is always a
 * denial: 404 (not found in scope) or 403 (found but not permitted).
 */
export interface IdorActor {
  label: string
  workspace: string
  repositories: { open: string; restricted: string }
  otherWorkspace: string
  otherRepositories: { open: string; restricted: string }
  /** True when the actor is a plain member without restricted-repository access. */
  plainMember: boolean
}

export interface IdorCase {
  actor: string
  method: string
  path: string
  reason: string
}

export const DENIED = [403, 404]

function fill(pattern: string, values: Record<string, string>): string {
  return pattern.replace(/:([A-Za-z_]+)\??/g, (_, name: string) => values[name] ?? 'missing')
}

export function generateIdorMatrix(routes: RouteShape[], actors: IdorActor[]): IdorCase[] {
  const cases: IdorCase[] = []
  for (const route of routes.filter((r) => isResourceRoute(r.pattern))) {
    for (const method of route.methods.filter((m) => m !== 'HEAD')) {
      for (const actor of actors) {
        const foreign = {
          workspace: actor.otherWorkspace,
          repository: actor.otherRepositories.open,
        }
        cases.push({
          actor: actor.label,
          method,
          path: fill(route.pattern, foreign),
          reason: 'foreign workspace',
        })
        if (route.pattern.includes(':repository')) {
          cases.push({
            actor: actor.label,
            method,
            path: fill(route.pattern, {
              workspace: actor.workspace,
              repository: actor.otherRepositories.open,
            }),
            reason: 'own workspace, foreign repository',
          })
        }
        if (actor.plainMember && route.pattern.includes(':repository')) {
          cases.push({
            actor: actor.label,
            method,
            path: fill(route.pattern, {
              workspace: actor.workspace,
              repository: actor.repositories.restricted,
            }),
            reason: 'restricted repository without membership',
          })
        }
      }
    }
  }
  return cases
}
