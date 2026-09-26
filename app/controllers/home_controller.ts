import type { HttpContext } from '@adonisjs/core/http'
import { landingPathFor } from '#app/auth/landing'

export default class HomeController {
  /** Signed-in users never see the landing page: `/` forwards them to where their work is. */
  async index({ auth, inertia, response }: HttpContext) {
    if (await auth.use('web').check()) {
      return response
        .redirect()
        .withQs(false)
        .toPath(await landingPathFor(auth.user!.id))
    }
    return inertia.render('home', {})
  }
}
