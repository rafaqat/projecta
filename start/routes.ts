/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import env from '#start/env'
import { middleware } from '#start/kernel'
import router from '@adonisjs/core/services/router'

// Controllers as lazy imports (no #generated barrel): each route references only the
// controllers it needs, so this file scales down cleanly to each vertical slice.
const HomeController = () => import('#controllers/home_controller')
const OidcController = () => import('#controllers/oidc_controller')
const BomSharesController = () => import('#controllers/bom_shares_controller')
const WebhooksController = () => import('#controllers/webhooks_controller')
const WorkspacesController = () => import('#controllers/workspaces_controller')
const AboutController = () => import('#controllers/about_controller')
const ReleasesController = () => import('#controllers/releases_controller')
const IsolationController = () => import('#controllers/isolation_controller')
const SpendController = () => import('#controllers/spend_controller')
const RepositoriesController = () => import('#controllers/repositories_controller')
const DuplicatesController = () => import('#controllers/duplicates_controller')
const DependenciesController = () => import('#controllers/dependencies_controller')
const TurnsController = () => import('#controllers/turns_controller')
const DecisionsController = () => import('#controllers/decisions_controller')
const NewAccountController = () => import('#controllers/new_account_controller')
const SessionController = () => import('#controllers/session_controller')

router.get('/', [HomeController, 'index']).as('home')

// Liveness for container health checks; carries no state and no content.
router.get('/healthz', () => ({ status: 'ok' })).as('healthz')

// OIDC sign-in. The provider is the mock locally and Entra ID on Azure.
router.get('/auth/login', [OidcController, 'start']).as('auth.login').use(middleware.guest())
router.get('/auth/callback', [OidcController, 'callback']).as('auth.callback')
router.post('/auth/logout', [OidcController, 'signOut']).as('auth.logout').use(middleware.auth())
router.get('/api/me', [OidcController, 'me']).as('api.me').use(middleware.auth())

// BOM share links (WP-23): the only route serving tenant data without a session. It is
// outside the auth group on purpose; the handler resolves the token's creator and re-checks their
// access itself, and ShareRouteMiddleware strips every cookie from the response.
router.get('/s/bom/:token', [BomSharesController, 'fetch']).as('bom_shares.fetch')

// Push webhooks (SEC-32): routed by an unguessable inbox handle and
// authenticated by signature, never by session. CSRF is exempted in config/shield.ts.
router.post('/webhooks/github/:hook', [WebhooksController, 'github']).as('webhooks.github')

// Resource routes: opaque handles in URLs, a declared policy on
// every route, default-deny enforced by ResourceGuardMiddleware.
router
  .group(() => {
    router.get('/workspaces', [WorkspacesController, 'index']).as('workspaces.index')
    // About this deployment (WP-26): deployment facts, no tenant data; signed-in only.
    router.get('/about', [AboutController, 'show']).as('about.show')
    router
      .get('/w/:workspace', [WorkspacesController, 'show'])
      .as('workspaces.show')
      .use(middleware.authorize({ resource: 'workspace', ability: 'view' }))
    router
      .get('/w/:workspace/releases', [ReleasesController, 'index'])
      .as('releases.index')
      .use(middleware.authorize({ resource: 'workspace', ability: 'view' }))
    router
      .get('/w/:workspace/isolation', [IsolationController, 'index'])
      .as('isolation.index')
      .use(middleware.authorize({ resource: 'workspace', ability: 'view' }))
    // Attributed spend (WP-25): one's own for any member; per member for an owner only,
    // checked in the handler so everyone else gets a 404, not a 403 that confirms it exists.
    router
      .get('/api/w/:workspace/spend', [SpendController, 'own'])
      .as('spend.own')
      .use(middleware.authorize({ resource: 'workspace', ability: 'view' }))
    router
      .get('/api/w/:workspace/spend/members', [SpendController, 'members'])
      .as('spend.members')
      .use(middleware.authorize({ resource: 'workspace', ability: 'view' }))
    router
      .get('/api/w/:workspace/members', [WorkspacesController, 'members'])
      .as('workspaces.members')
      .use(middleware.authorize({ resource: 'workspace', ability: 'view' }))
    router
      .post('/w/:workspace/repos', [RepositoriesController, 'store'])
      .as('repositories.store')
      .use(middleware.authorize({ resource: 'workspace', ability: 'manage' }))
    router
      .get('/api/w/:workspace/r/:repository/files', [RepositoriesController, 'files'])
      .as('repositories.files')
      .use(middleware.authorize({ resource: 'repository', ability: 'view' }))
    router
      .get('/api/w/:workspace/r/:repository/declaration', [RepositoriesController, 'declaration'])
      .as('repositories.declaration')
      .use(middleware.authorize({ resource: 'repository', ability: 'view' }))
    router
      .get('/w/:workspace/r/:repository', [RepositoriesController, 'show'])
      .as('repositories.show')
      .use(middleware.authorize({ resource: 'repository', ability: 'view' }))
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
    // Ingestion from the repository page: status and steps for anyone who can view;
    // queueing a run again and deleting the repository with its index need manage.
    router
      .get('/api/w/:workspace/r/:repository/ingest', [RepositoriesController, 'ingestStatus'])
      .as('repositories.ingest')
      .use(middleware.authorize({ resource: 'repository', ability: 'view' }))
    router
      .post('/api/w/:workspace/r/:repository/ingest', [RepositoriesController, 'reindex'])
      .as('repositories.reindex')
      .use(middleware.authorize({ resource: 'repository', ability: 'manage' }))
    router
      .patch('/w/:workspace/r/:repository', [RepositoriesController, 'update'])
      .as('repositories.update')
      .use(middleware.authorize({ resource: 'repository', ability: 'manage' }))
    router
      .delete('/w/:workspace/r/:repository', [RepositoriesController, 'destroy'])
      .as('repositories.destroy')
      .use(middleware.authorize({ resource: 'repository', ability: 'manage' }))
    // Answer loop (design §6): the only route into Orchestrator.run; no route exposes resume.
    router
      .get('/api/w/:workspace/r/:repository/scope', [TurnsController, 'scope'])
      .as('turns.scope')
      .use(middleware.authorize({ resource: 'repository', ability: 'view' }))
    router
      .post('/api/w/:workspace/r/:repository/turns', [TurnsController, 'stream'])
      .as('turns.stream')
      .use(middleware.authorize({ resource: 'repository', ability: 'view' }))
    // The reader's thread for the repository: loaded on the page, continued by handle,
    // cleared through erasure. Each turn carries its cost from the ledger.
    router
      .get('/api/w/:workspace/r/:repository/history', [TurnsController, 'history'])
      .as('turns.history')
      .use(middleware.authorize({ resource: 'repository', ability: 'view' }))
    router
      .delete('/api/w/:workspace/r/:repository/history', [TurnsController, 'clearHistory'])
      .as('turns.clear')
      .use(middleware.authorize({ resource: 'repository', ability: 'view' }))
    // Decision drawer (design §9): the record and review history of one turn; reviews append to the outbox.
    router
      .get('/api/w/:workspace/r/:repository/turns/:turn/decision', [DecisionsController, 'show'])
      .as('decisions.show')
      .use(middleware.authorize({ resource: 'repository', ability: 'view' }))
    router
      .post('/api/w/:workspace/r/:repository/turns/:turn/review', [DecisionsController, 'review'])
      .as('decisions.review')
      .use(middleware.authorize({ resource: 'repository', ability: 'view' }))
  })
  .use(middleware.auth())

// Password login exists only for local development (SEC-37).
if (env.get('APP_ENV') === 'local') {
  router
    .group(() => {
      router.get('signup', [NewAccountController, 'create'])
      router.post('signup', [NewAccountController, 'store'])

      router.get('login', [SessionController, 'create'])
      router.post('login', [SessionController, 'store'])
    })
    .use(middleware.guest())

  router
    .group(() => {
      router.post('logout', [SessionController, 'destroy'])
    })
    .use(middleware.auth())
}
