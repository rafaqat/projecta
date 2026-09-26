/**
 * Dependency names that are also general-knowledge subjects. The imports
 * are the point; the functions only keep them referenced.
 */
import express from 'express'
import helmet from 'helmet'
import moment from 'moment'
import passport from 'passport'
import winston from 'winston'

export function createApp() {
  const app = express()
  app.use(helmet())
  app.use(passport.initialize())
  return app
}

export function startedAt(): string {
  return moment().toISOString()
}

export const logger = winston.createLogger({ level: 'info' })
