import { middleware } from '#start/kernel'
import router from '@adonisjs/core/services/router'

/**
 * Structure routes (slice 5): clone classes, the dependency/SBOM export of a turn's commit, and the
 * share links over that export.
 */
const BomSharesController = () => import('#controllers/bom_shares_controller')
const DuplicatesController = () => import('#controllers/duplicates_controller')
const DependenciesController = () => import('#controllers/dependencies_controller')

// BOM share links (WP-23): the only route serving tenant data without a session. It is
// outside the auth group on purpose; the handler resolves the token's creator and re-checks their
// access itself, and ShareRouteMiddleware strips every cookie from the response.
router.get('/s/bom/:token', [BomSharesController, 'fetch']).as('bom_shares.fetch')

router
  .group(() => {
    // Duplicates: the active commit's clone classes, browsable. Read-only, view scope.
    router
      .get('/w/:workspace/r/:repository/duplicates', [DuplicatesController, 'index'])
      .as('duplicates.index')
      .use(middleware.authorize({ resource: 'repository', ability: 'view' }))
    // Dependency export (/074, WP-21/22): the dependency table of the commit a turn was
    // grounded at, as SPDX or CycloneDX. Keyed by the turn's handle, not the commit SHA (INV-10:
    // no route takes a bare SHA), which is also exactly "the table this answer's card showed".
    router
      .get('/api/w/:workspace/r/:repository/turns/:turn/dependencies/spdx', [
        DependenciesController,
        'spdx',
      ])
      .as('dependencies.spdx')
      .use(middleware.authorize({ resource: 'repository', ability: 'view' }))
    router
      .get('/api/w/:workspace/r/:repository/turns/:turn/dependencies/cyclonedx', [
        DependenciesController,
        'cyclonedx',
      ])
      .as('dependencies.cyclonedx')
      .use(middleware.authorize({ resource: 'repository', ability: 'view' }))
    // Share links (WP-23): created, listed and revoked under the reader's session.
    router
      .post('/api/w/:workspace/r/:repository/turns/:turn/dependencies/links', [
        BomSharesController,
        'store',
      ])
      .as('bom_shares.store')
      .use(middleware.authorize({ resource: 'repository', ability: 'view' }))
    router
      .get('/api/w/:workspace/r/:repository/turns/:turn/dependencies/links', [
        BomSharesController,
        'index',
      ])
      .as('bom_shares.index')
      .use(middleware.authorize({ resource: 'repository', ability: 'view' }))
    router
      .delete('/api/w/:workspace/r/:repository/dependencies/links/:link', [
        BomSharesController,
        'destroy',
      ])
      .as('bom_shares.destroy')
      .use(middleware.authorize({ resource: 'repository', ability: 'view' }))
  })
  .use(middleware.auth())
