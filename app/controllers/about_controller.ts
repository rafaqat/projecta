import type { HttpContext } from '@adonisjs/core/http'
import env from '#start/env'
import { configHash, validatedRunFor } from '#app/audit/config_hash'
import { buildIdentity, chainBadge } from '#app/deployment/about'
import { lastVerification } from '#app/deployment/verification'

/** A verdict older than this turns the badge stale: a nightly verification, plus a margin. */
const STALE_HOURS = Number(process.env.ABOUT_CHAIN_STALE_HOURS ?? 26)

/**
 * "About this deployment" (WP-26): what this system is, for a signed-in reader, reached
 * from the decision drawer. Each claim is one the page can make: identity it was not given reads
 * "not recorded", and the chain badge reports the last verification and its age, never a live check.
 */
export default class AboutController {
  async show({ inertia }: HttpContext) {
    const { hash } = configHash()
    const run = validatedRunFor(hash)
    return inertia.render('about/show', {
      appVersion: env.get('APP_VERSION'),
      configHash: hash,
      validation: {
        run,
        text: run ? `validated by ${run}` : 'not validated by any recorded eval run',
      },
      identity: buildIdentity(process.env),
      chain: chainBadge(await lastVerification(), new Date(), STALE_HOURS * 3_600_000),
    })
  }
}
