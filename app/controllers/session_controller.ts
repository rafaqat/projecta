import User from '#models/user'
import { loginValidator } from '#validators/user'
import type { HttpContext } from '@adonisjs/core/http'
import { landingPathFor } from '#app/auth/landing'
import { securityEvents } from '#app/security/events/index'

export default class SessionController {
  async create({ inertia }: HttpContext) {
    return inertia.render('auth/login', {})
  }

  async store({ request, auth, response }: HttpContext) {
    const { email, password } = await request.validateUsing(loginValidator)
    let user: User
    try {
      user = await User.verifyCredentials(email, password)
    } catch (error) {
      securityEvents.emit('auth.sign_in.failed', {
        issuer: 'local',
        reason: 'invalid_credentials',
        requestId: request.id() ?? '',
      })
      throw error
    }

    await auth.use('web').login(user)
    securityEvents.emit('auth.sign_in.succeeded', {
      issuer: 'local',
      sessionId: request.id() ?? '',
    })
    response.redirect().toPath(await landingPathFor(user.id))
  }

  async destroy({ auth, response }: HttpContext) {
    await auth.use('web').logout()
    response.redirect().toPath('/login')
  }
}
