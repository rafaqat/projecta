import { test } from '@japa/runner'
import { extractEndpoints } from '#app/parse/extractors/endpoints'

/**
 * AdonisJS routes live on the default-imported `router` service. A route's handler is either a
 * `[Controller, 'method']` tuple (lazy controller), a `'Controller.method'` string, or a closure
 * (no named handler). A `router.group(() => {...}).prefix('/x')` composes its prefix onto every
 * route declared inside the closure — the extractor resolves that by byte-span containment.
 */
const ADONIS_ROUTES = `
import router from '@adonisjs/core/services/router'
import HomeController from '#controllers/home_controller'

router.get('/', [HomeController, 'index']).as('home')
router.get('/healthz', () => ({ status: 'ok' }))
router.post('/legacy', 'LegacyController.store')
router.any('/webhook', [HooksController, 'receive'])

router
  .group(() => {
    router.get('/members', [MembersController, 'list'])
    router.delete('/members/:id', [MembersController, 'remove'])
  })
  .prefix('/api/w/:workspace')
`

test.group('AdonisJS endpoint extractor (slice-2 ingest)', () => {
  test('extracts top-level routes, tuple/string/closure handlers, and group prefixes', async ({
    assert,
  }) => {
    const endpoints = await extractEndpoints({ 'start/routes.ts': ADONIS_ROUTES })
    const adonis = endpoints.filter((e) => e.framework === 'adonis')
    const by = (method: string, path: string) =>
      adonis.find((e) => e.method === method && e.path === path)

    // Every extracted route is AdonisJS and nothing leaked to another framework.
    assert.equal(adonis.length, endpoints.length)
    assert.equal(adonis.length, 6)

    // A `[Controller, 'method']` tuple handler, chained with `.as()`.
    assert.equal(by('GET', '/')?.handler, 'HomeController.index')

    // A closure handler has no name.
    assert.equal(by('GET', '/healthz')?.handler, null)

    // A `'Controller.method'` string handler is kept verbatim.
    assert.equal(by('POST', '/legacy')?.handler, 'LegacyController.store')

    // `router.any(...)` records the ANY method.
    assert.equal(by('ANY', '/webhook')?.handler, 'HooksController.receive')

    // The group's `.prefix('/api/w/:workspace')` composes onto both inner routes.
    assert.equal(by('GET', '/api/w/:workspace/members')?.handler, 'MembersController.list')
    assert.equal(by('DELETE', '/api/w/:workspace/members/:id')?.handler, 'MembersController.remove')
  }).tags(['wp-ingest', 'parse'])
})
