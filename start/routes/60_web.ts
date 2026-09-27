import env from '#start/env'
import { middleware } from '#start/kernel'
import router from '@adonisjs/core/services/router'

/**
 * Web interface routes (slice 6): the workspace pages, the deployment "about" page, releases,
 * isolation, attributed spend, and local-development account creation.
 */
const WorkspacesController = () => import('#controllers/workspaces_controller')
const AboutController = () => import('#controllers/about_controller')
const ReleasesController = () => import('#controllers/releases_controller')
const IsolationController = () => import('#controllers/isolation_controller')
const SpendController = () => import('#controllers/spend_controller')
const NewAccountController = () => import('#controllers/new_account_controller')

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
  })
  .use(middleware.auth())

// Account creation exists only for local development (SEC-37).
if (env.get('APP_ENV') === 'local') {
  router
    .group(() => {
      router.get('signup', [NewAccountController, 'create'])
      router.post('signup', [NewAccountController, 'store'])
    })
    .use(middleware.guest())
}
