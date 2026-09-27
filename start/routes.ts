/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Route fragments, one per vertical slice (start/routes/*). Each fragment registers only the routes
 * whose controllers its own slice carries, so a slice checked out on its own resolves, type-checks and
 * boots: the router no longer names every controller in the application.
 *
 * The fragments are loaded by scanning the directory rather than by static import, on purpose. A
 * static `import './routes/60-web.js'` would make every earlier slice reference a file it does not
 * carry, which is the coupling this split exists to remove. The scan sees `.ts` under the dev loader
 * and `.js` in the compiled build, and is sorted so registration order is deterministic.
 */
const fragmentsDir = join(dirname(fileURLToPath(import.meta.url)), 'routes')
let fragments: string[] = []
try {
  fragments = readdirSync(fragmentsDir)
    .filter((entry) => /\.(ts|js)$/.test(entry) && !entry.endsWith('.d.ts'))
    .sort()
} catch {
  // A slice that registers no HTTP routes carries no fragments directory: nothing to load.
  fragments = []
}
for (const fragment of fragments) await import(join(fragmentsDir, fragment))
