#!/usr/bin/env node
// Writes build-manifest.json: every module (extension removed) bundled into an image
// target (ADR-020). CI intersects it with test-modules.json for production
// targets, and production boot refuses to start if any test module appears.
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const [root, out, target] = process.argv.slice(2)
if (!root || !out || !target) {
  console.error('usage: build-manifest.mjs <root> <out> <target>')
  process.exit(2)
}

const modules = []
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full)
    else if (/\.(js|mjs|cjs|ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) {
      modules.push(relative(root, full).replace(/\.(js|mjs|cjs|ts|tsx)$/, ''))
    }
  }
}
walk(root)
modules.sort()
writeFileSync(out, JSON.stringify({ target, generatedAt: new Date().toISOString(), modules }, null, 2) + '\n')
console.log(`${out}: ${modules.length} modules for target ${target}`)
