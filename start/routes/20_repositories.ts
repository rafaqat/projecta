import { middleware } from '#start/kernel'
import router from '@adonisjs/core/services/router'

/**
 * Repository registration, browsing and ingestion routes (slice 2), plus the push webhook.
 */
const WebhooksController = () => import('#controllers/webhooks_controller')
const RepositoriesController = () => import('#controllers/repositories_controller')

// Push webhooks (SEC-32): routed by an unguessable inbox handle and
// authenticated by signature, never by session. CSRF is exempted in config/shield.ts.
router.post('/webhooks/github/:hook', [WebhooksController, 'github']).as('webhooks.github')

router
  .group(() => {
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
  })
  .use(middleware.auth())
