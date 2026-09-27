import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The actor on whose behalf the current asynchronous work runs. Every span
 * exported from that work is attributed to it (INV-03).
 */
export type Actor =
  { kind: 'user'; userId: string; workspaceId?: string } | { kind: 'system'; job: string }

const storage = new AsyncLocalStorage<Actor>()

export function runWithActor<T>(actor: Actor, fn: () => T): T {
  return storage.run(actor, fn)
}

export function currentActor(): Actor | undefined {
  return storage.getStore()
}
