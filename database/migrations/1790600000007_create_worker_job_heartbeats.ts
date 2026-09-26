import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Worker liveness for orphan-job reclaim. A worker heartbeats the ingest job it holds; on
 * restart a worker reclaims only jobs whose heartbeat has gone stale, so a live peer's job (Azure
 * runs several app replicas) is never failed out from under it and re-ingested. Operational rows —
 * a pg-boss job id, the worker holding it and the last beat — with no tenant content, so no RLS.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('worker_job_heartbeats', (table) => {
      table.uuid('job_id').primary()
      table.string('worker_id', 64).notNullable()
      table.timestamp('beat_at', { useTz: true }).notNullable()
    })
  }

  async down() {
    this.schema.dropTable('worker_job_heartbeats')
  }
}
