#!/usr/bin/env node
// Copy the files adonisrc declares as `metaFiles` into the build output.
//
// `node ace build` does this as part of the assembler. The backend-only build path — a tree that
// carries no frontend, where the vite provider's build hook cannot run — uses `tsc` alone, which
// emits compiled JavaScript and nothing else. The prompts, policies, views and profiles the
// application opens BY PATH were therefore absent from the image, and it failed at first use:
// `gateway-policy` exited on `ENOENT ... app/assistant/prompts/system.v7.md`.
//
// adonisrc's metaFiles list is the single source of truth for what is read by path, so this reads
// it rather than repeating it: a new entry there is carried into the image without touching this.
import { copyFileSync, existsSync, globSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = process.argv[2] ?? 'build'
// `--verify` checks instead of copying, so the same list gates BOTH build paths: the assembler's
// and the backend-only one. A file read by path that never reached the image is otherwise found
// only when a container opens it.
const verify = process.argv.includes('--verify')
const root = process.cwd()

const config = (await import(pathToFileURL(join(root, 'adonisrc.ts')).href)).default
const patterns = (config.metaFiles ?? []).map((entry) =>
  typeof entry === 'string' ? entry : entry.pattern
)

let seen = 0
const missing = []
for (const pattern of patterns) {
  for (const match of globSync(pattern, { cwd: root })) {
    const from = join(root, match)
    if (!statSync(from).isFile()) continue
    const to = join(root, out, relative(root, from))
    seen++
    if (verify) {
      if (!existsSync(to)) missing.push(relative(root, from))
      continue
    }
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
  }
}

console.log(
  `${out}: ${seen} meta files from ${patterns.length} patterns${verify ? ' checked' : ' copied'}`
)
// Zero matches is not a fault: a vertical slice carries only its own files, and the views arrive
// with the interface while the prompts arrive with the assistant, so the earliest slices match
// none of these patterns. The gate is the comparison below, which is slice-safe by construction
// because it only looks for files the source actually has.
if (missing.length) {
  console.error(`${missing.length} file(s) read by path are absent from ${out}:`)
  for (const path of missing.slice(0, 20)) console.error(`  ${path}`)
  process.exit(1)
}
