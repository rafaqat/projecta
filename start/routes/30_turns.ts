import { middleware } from '#start/kernel'
import router from '@adonisjs/core/services/router'

/**
 * Cited-answer routes (slice 3): the answer loop, the reader's thread, and the decision drawer.
 */
const TurnsController = () => import('#controllers/turns_controller')
const DecisionsController = () => import('#controllers/decisions_controller')

router
  .group(() => {
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
