import env from '#start/env'
import { middleware } from '#start/kernel'
import router from '@adonisjs/core/services/router'

/**
 * Identity and tenancy routes (slice 1): the landing page, liveness, and the OIDC sign-in flow.
 * Controllers are lazy imports, so this fragment names only the controllers its own slice carries.
 */
const HomeController = () => import('#controllers/home_controller')
const OidcController = () => import('#controllers/oidc_controller')
const SessionController = () => import('#controllers/session_controller')

router.get('/', [HomeController, 'index']).as('home')

// Liveness for container health checks; carries no state and no content.
router.get('/healthz', () => ({ status: 'ok' })).as('healthz')

// OIDC sign-in. The provider is the mock locally and Entra ID on Azure.
router.get('/auth/login', [OidcController, 'start']).as('auth.login').use(middleware.guest())
router.get('/auth/callback', [OidcController, 'callback']).as('auth.callback')
router.post('/auth/logout', [OidcController, 'signOut']).as('auth.logout').use(middleware.auth())
router.get('/api/me', [OidcController, 'me']).as('api.me').use(middleware.auth())

// Password login exists only for local development (SEC-37).
if (env.get('APP_ENV') === 'local') {
  router
    .group(() => {
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
