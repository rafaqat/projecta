import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * `node ace sessions:prune` — trims the database session store (SESSION_DRIVER=database). Adonis
 * writes one row per browser session but never garbage-collects them, so a busy or cookieless-heavy
 * deployment grows the `sessions` table without bound. By default it deletes only expired rows (safe
 * for a cron: an expired row can no longer authenticate). `--empty` also removes anonymous sessions —
 * ones carrying no authenticated guard and no in-flight sign-in — which is what cookieless requests
 * (health checks, unauthenticated API hits) leave behind; a logged-in or mid-login session is kept.
 * `--grace <minutes>` keeps rows that expired within that window (clock-skew margin); `--dry-run`
 * reports the counts and deletes nothing.
 */
export default class SessionsPrune extends BaseCommand {
  static commandName = 'sessions:prune'
  static description =
    'Delete expired (and optionally anonymous) rows from the database session store'
  static options: CommandOptions = { startApp: true }

  @flags.boolean({
    description: 'Also delete anonymous sessions (no login, no in-flight sign-in)',
    default: false,
  })
  declare empty: boolean

  @flags.number({
    description: 'Keep rows that expired within this many minutes (clock-skew margin)',
    default: 0,
  })
  declare grace: number

  @flags.boolean({ description: 'Report the counts, delete nothing', default: false })
  declare dryRun: boolean

  async run() {
    const { default: db } = await import('@adonisjs/lucid/services/db')
    const grace = Number.isFinite(this.grace) && this.grace > 0 ? this.grace : 0
    // An authenticated session carries the web guard; a mid-sign-in one carries the OIDC/pending
    // state. Anything with neither can authenticate no one, so `--empty` may reclaim it.
    const HELD = "(data like '%auth_web%' or data like '%oidc%' or data like '%pending%')"
    const target = () => {
      const q = db
        .from('sessions')
        .whereRaw('expires_at < now() - make_interval(mins => ?)', [grace])
      return this.empty ? q.orWhereRaw(`not ${HELD}`) : q
    }
    if (this.dryRun) {
      const row = await target().count('* as n').first()
      this.logger.info(
        `${Number(row?.n ?? 0)} session row(s) would be deleted (expired${this.empty ? ' + anonymous' : ''})`
      )
      return
    }
    const deleted = await target().delete()
    const remaining = await db.from('sessions').count('* as n').first()
    this.logger.success(`deleted ${deleted} session row(s); ${Number(remaining?.n ?? 0)} remain`)
    await db.manager.closeAll()
  }
}
