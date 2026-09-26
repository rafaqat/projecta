import { test } from '@japa/runner'
import router from '@adonisjs/core/services/router'
import { HttpContextFactory } from '@adonisjs/core/factories/http'
import ResourceGuardMiddleware from '#middleware/resource_guard_middleware'
import {
  findForbiddenParams,
  findUnguardedRoutes,
  type RouteShape,
} from '#app/security/route_policies'
import { resolveWorkspace } from '#app/security/resource_scope'

function liveRoutes(): RouteShape[] {
  return Object.values(router.toJSON())
    .flat()
    .map((route) => ({
      pattern: route.pattern,
      methods: route.methods,
      middlewareNames: Array.from(route.middleware.all(), (m) =>
        typeof m === 'object' && 'name' in m ? String(m.name) : ''
      ),
    }))
}

test.group('default-deny resource routes (SEC-22)', () => {
  test('every registered resource route declares a policy', ({ assert }) => {
    const routes = liveRoutes()
    assert.isNotEmpty(routes.filter((r) => r.middlewareNames.includes('authorize')))
    assert.deepEqual(findUnguardedRoutes(routes), [])
  }).tags(['AC-WP02-04', 'wp02'])

  test('a route without a declared policy, added as a fixture, fails the coverage check', ({
    assert,
  }) => {
    const fixture: RouteShape = {
      pattern: '/w/:workspace/settings',
      methods: ['GET'],
      middlewareNames: ['auth'],
    }
    const findings = findUnguardedRoutes([...liveRoutes(), fixture])
    assert.deepEqual(findings, [fixture])
  }).tags(['AC-WP02-04', 'wp02'])

  test('at runtime, a resource route reaching the router without a policy is refused', async ({
    assert,
  }) => {
    const ctx = new HttpContextFactory().create()
    ctx.route = { pattern: '/w/:workspace/settings', middleware: { all: () => new Set() } } as never
    await assert.rejects(
      () => new ResourceGuardMiddleware().handle(ctx, async () => 'handler ran'),
      /Forbidden/
    )
  }).tags(['AC-WP02-04', 'wp02'])

  test('no route parameter is a bare database ID or SHA', ({ assert }) => {
    assert.deepEqual(findForbiddenParams(liveRoutes()), [])
  }).tags(['AC-WP02-09', 'wp02'])

  test('URL parameters that are not opaque handles are refused before any lookup', async ({
    assert,
  }) => {
    for (const notAHandle of [
      '1',
      '42',
      'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      'acme',
      '../x',
      '',
    ]) {
      await assert.rejects(() => resolveWorkspace(1, notAHandle), /Not found/)
    }
  }).tags(['AC-WP02-09', 'wp02'])
})
