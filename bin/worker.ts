/*
|--------------------------------------------------------------------------
| Worker entrypoint
|--------------------------------------------------------------------------
|
| Boots the application without the HTTP server. pg-boss job handlers
| register here from WP-03 onward (ADR-008). CPU-heavy work runs only in
| this process (ADR-001).
|
*/

import '../otel.js'
import 'reflect-metadata'
import { writeFile } from 'node:fs/promises'
import { Ignitor, prettyPrintError } from '@adonisjs/core'

const APP_ROOT = new URL('../', import.meta.url)

const IMPORTER = (filePath: string) => {
  if (filePath.startsWith('./') || filePath.startsWith('../')) {
    return import(new URL(filePath, APP_ROOT).href)
  }
  return import(filePath)
}

const READY_FILE = process.env.WORKER_READY_FILE ?? '/tmp/worker.ready'

// Tells the security provider this console process serves tenant data (database role guard).
process.env.APP_PROCESS = 'worker'

const app = new Ignitor(APP_ROOT, { importer: IMPORTER })
  .tap((application) => {
    application.booting(async () => {
      await import('#start/env')
    })
    application.listen('SIGTERM', () => application.terminate())
    application.listenIf(application.managedByPm2, 'SIGINT', () => application.terminate())
  })
  .createApp('console')

try {
  await app.init()
  await app.boot()
  await app.start(async () => {
    const { startIngestWorker, stopIngestQueue } = await import('#app/ingest/queue')
    const { warmInjectionDetector } = await import('#app/parse/injection')
    const { announceModelBackend } = await import('#app/parse/model_server')
    await announceModelBackend(await app.container.make('logger'))
    await warmInjectionDetector()
    await startIngestWorker()
    app.terminating(() => stopIngestQueue())
    await writeFile(READY_FILE, new Date().toISOString())
    const logger = await app.container.make('logger')
    logger.info('worker ready: ingest queue attached')
  })
} catch (error) {
  process.exitCode = 1
  prettyPrintError(error)
}
