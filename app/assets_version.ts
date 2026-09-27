import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import app from '@adonisjs/core/services/app'

/**
 * The build's asset version: a hash of Vite's manifest, which changes with every bundle. A page
 * streams answers without navigating, so it can keep an old bundle for hours after a deploy
 * (UAT 2026-09-17: an owner saw the previous progress row and no auto-continue). The turn route
 * sends this in a header; the page compares it with the version it rendered with, and asks for a
 * reload when they differ.
 */
let cached: string | undefined
export function assetsVersion(): string {
  if (cached) return cached
  try {
    const manifest = readFileSync(app.makePath('public/assets/.vite/manifest.json'))
    cached = createHash('sha256').update(manifest).digest('hex').slice(0, 16)
  } catch {
    cached = 'dev'
  }
  return cached
}
