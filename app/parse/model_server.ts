import { readFileSync } from 'node:fs'
import app from '@adonisjs/core/services/app'

/**
 * The model server: one URL serving the two pinned models on the
 * GPU it has. `MODEL_SERVER_URL` selects it in web and worker alike; unset,
 * the in-process ONNX models serve. The server's identity is checked once
 * against models.lock.json so a wrong revision is refused before a vector
 * or a flag is taken from it, and the backend it names becomes part of the
 * model identity (a different cache key).
 */
export class ModelServerError extends Error {
  constructor(
    readonly code:
      'E_MODEL_SERVER_UNAVAILABLE' | 'E_MODEL_SERVER_REVISION' | 'E_MODEL_SERVER_RESPONSE',
    message: string,
    readonly cause?: unknown
  ) {
    super(message)
  }
}

export interface ServedModel {
  id: string
  revision: string
  /** Runtime, precision and device: `torch-fp16-mps`, `torch-fp16-cuda`, `torch-fp32-cpu`. */
  backend: string
}

export interface ModelServerHealth {
  device: string
  models: { embedder: ServedModel; classifier: ServedModel }
}

export function modelServerUrl(): string | null {
  const url = process.env.MODEL_SERVER_URL?.trim()
  return url ? url.replace(/\/$/, '') : null
}

const healthChecks = new Map<string, Promise<ModelServerHealth>>()

/** The server's identity, fetched once per URL for the life of the process. */
export function modelServerHealth(url: string): Promise<ModelServerHealth> {
  let pending = healthChecks.get(url)
  if (!pending) {
    pending = fetchHealth(url).catch((error) => {
      healthChecks.delete(url) // an outage is retried on the next use
      throw error
    })
    healthChecks.set(url, pending)
  }
  return pending
}

async function fetchHealth(url: string): Promise<ModelServerHealth> {
  const body = await request<ModelServerHealth>(url, '/healthz')
  if (!body?.models?.embedder?.revision || !body?.models?.classifier?.revision)
    throw new ModelServerError('E_MODEL_SERVER_RESPONSE', `${url}/healthz: no model identity`)
  return body
}

/** Refuses a server whose copy of a model is not the pinned revision. */
export async function servedModel(
  url: string,
  which: 'embedder' | 'classifier',
  pinned: { id: string; revision: string }
): Promise<ServedModel> {
  const health = await modelServerHealth(url)
  const served = health.models[which]
  if (served.id !== pinned.id || served.revision !== pinned.revision)
    throw new ModelServerError(
      'E_MODEL_SERVER_REVISION',
      `${url} serves ${which} ${served.id}@${served.revision.slice(0, 12)}; models.lock.json pins ${pinned.id}@${pinned.revision.slice(0, 12)}`
    )
  return served
}

export async function request<T>(url: string, route: string, body?: unknown): Promise<T> {
  let response: Response | undefined
  // One retry for a connection that did not happen (a proxy tunnel refused under load); a
  // request the server answered is never sent twice.
  for (let attempt = 0; attempt < 2 && !response; attempt++) {
    try {
      response = await fetch(`${url}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.MODEL_SERVER_TIMEOUT_MS ?? 120_000)),
      })
    } catch (error) {
      if (attempt === 0) continue
      throw new ModelServerError(
        'E_MODEL_SERVER_UNAVAILABLE',
        `model server ${url}${route}: ${error instanceof Error ? error.message : String(error)}`,
        error
      )
    }
  }
  if (!response)
    throw new ModelServerError('E_MODEL_SERVER_UNAVAILABLE', `model server ${url}${route}`)
  if (!response.ok)
    throw new ModelServerError(
      'E_MODEL_SERVER_RESPONSE',
      `model server ${url}${route}: HTTP ${response.status}`
    )
  return (await response.json()) as T
}

/** The lock's entry for a purpose, as the adapters compare it. */
export function pinnedModel(purpose: 'code embeddings' | 'injection detector'): {
  id: string
  revision: string
} {
  const lock = JSON.parse(readFileSync(app.makePath('models.lock.json'), 'utf8')) as {
    models: Array<{ id: string; revision: string; purpose: string }>
  }
  const model = lock.models.find((m) => m.purpose.startsWith(purpose))
  if (!model) throw new Error(`models.lock.json has no ${purpose} model`)
  return { id: model.id, revision: model.revision }
}

/** Where the host's model server is reached from a container (`make model-server`); probed only to warn. */
const HOST_MODEL_SERVER_CANDIDATES = ['http://host.docker.internal:8765', 'http://127.0.0.1:8765']

/**
 * Says at boot which model backend this process will use, and warns when it is about to
 * run in-process although a model server answers on the host — the silent fallback that ran three
 * ingests on CPU in one night (2026-09-21) because a recreated container had an empty
 * MODEL_SERVER_URL. Never throws: a probe that fails is the absence of a server, which is fine.
 */
export async function announceModelBackend(log: {
  info: (o: object, msg: string) => void
  warn: (o: object, msg: string) => void
}): Promise<void> {
  const url = modelServerUrl()
  if (url) {
    log.info({ backend: 'remote', modelServerUrl: url }, 'model backend: remote model server')
    return
  }
  log.info(
    { backend: 'in-process' },
    'model backend: in-process ONNX on CPU (MODEL_SERVER_URL is empty)'
  )
  for (const candidate of HOST_MODEL_SERVER_CANDIDATES) {
    try {
      const response = await fetch(`${candidate}/healthz`, { signal: AbortSignal.timeout(1500) })
      if (response.ok) {
        log.warn(
          { candidate },
          'a model server answers on the host but MODEL_SERVER_URL is empty: embeddings and classification will run in-process on CPU, several times slower. Set MODEL_SERVER_URL in .env and recreate the container.'
        )
        return
      }
    } catch {
      // No server there: in-process is the intended default.
    }
  }
}
