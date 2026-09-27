/**
 * The receiver-type table: what the Node reference extractor knows about the outside
 * without a type checker. Each entry is a fact about a package a labelled fixture uses, recorded
 * by hand and extended one package at a time; a receiver with no entry yields an unresolved chain,
 * never a guessed type. The platform is named by module (`javascript`, `node:timers`,
 * `node:console`) the way the golden manifest names it.
 */
export interface ExternalType {
  module: string
  type: string
}

const EXPRESS = 'express'
const REGISTRATION = /^(get|post|put|patch|delete|options|head|all|use)$/

/** Whether the table has any entry for a package. */
export function knowsModule(module: string): boolean {
  return module === EXPRESS
}

/** What a call on an imported name yields: `express()` an Application, `Router()` a Router. */
export function typeOfImportCall(
  module: string,
  name: string,
  member: string | undefined
): ExternalType | undefined {
  if (module !== EXPRESS) return undefined
  // `express()` and `express.Router()` on the default import — or on the whole module, which is
  // what `const express = require('express')` binds; `Router()` on the named import.
  const whole = name === 'default' || name === '*'
  if (whole && !member) return { module: EXPRESS, type: 'Application' }
  if (whole && member === 'Router') return { module: EXPRESS, type: 'Router' }
  if (name === 'Router' && !member) return { module: EXPRESS, type: 'Router' }
  return undefined
}

/** What a method on an external type returns, when the chain continues on it. */
export function returnTypeOf(receiver: ExternalType, member: string): ExternalType | undefined {
  if (receiver.module === EXPRESS && receiver.type === 'Response' && member === 'status')
    return receiver
  if (receiver.module === EXPRESS && receiver.type === 'Request' && member === 'header')
    return STRING
  return undefined
}

/** The positional types of a callback passed to a route or middleware registration. */
export function callbackParameterTypes(
  receiver: ExternalType,
  member: string
): ExternalType[] | undefined {
  if (receiver.module !== EXPRESS) return undefined
  if (receiver.type !== 'Application' && receiver.type !== 'Router') return undefined
  if (!REGISTRATION.test(member)) return undefined
  return [
    { module: EXPRESS, type: 'Request' },
    { module: EXPRESS, type: 'Response' },
    { module: EXPRESS, type: 'NextFunction' },
  ]
}

export const STRING: ExternalType = { module: 'javascript', type: 'String' }

/** A type annotation the file writes that names a platform type. */
export function typeOfAnnotation(text: string): ExternalType | undefined {
  return text === 'string' ? STRING : undefined
}

/** Bare platform calls recorded as edges: `Number(x)`, `setTimeout(f, ms)`. */
export const PLATFORM_CALLS: Record<string, ExternalType> = {
  Number: { module: 'javascript', type: 'Number' },
  setTimeout: { module: 'node:timers', type: 'setTimeout' },
  setInterval: { module: 'node:timers', type: 'setInterval' },
  clearTimeout: { module: 'node:timers', type: 'clearTimeout' },
  clearInterval: { module: 'node:timers', type: 'clearInterval' },
}

/** Platform constructions recorded as edges: `new Promise`, `new Error`. */
export const PLATFORM_NEW: Record<string, ExternalType> = {
  Promise: { module: 'javascript', type: 'Promise' },
  Error: { module: 'javascript', type: 'Error' },
}

/** Platform objects whose members are recorded as edges: `console.log` → `node:console#log`. */
export const PLATFORM_OBJECTS: Record<string, string> = {
  console: 'node:console',
}
