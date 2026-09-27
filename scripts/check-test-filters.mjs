#!/usr/bin/env node
// Japa's --files matches test FILES. A value naming a directory matches nothing, the run reports
// "NO TESTS EXECUTED" and exits 0 -- so the step stays green while testing nothing. This refuses
// any --files value in a workflow that names a suite directory, and names the glob to use instead.
//
// A value whose directory is absent is accepted: a vertical slice carries only its own tests, and
// the filter is correct there even though nothing matches yet.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const WORKFLOWS = '.github/workflows'
const SUITES = ['unit', 'functional', 'conformance', 'structural', 'browser', 'e2e']

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const findings = []
for (const entry of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort()) {
  const lines = readFileSync(join(WORKFLOWS, entry), 'utf8').split('\n')
  lines.forEach((line, index) => {
    // The runner takes the suite positionally. `--suite` is not a flag it knows, so it is dropped
    // and every suite runs, with --files selecting across all of them: a unit filter then pulls in
    // the browser suite and its Playwright setup. `node test.js unit --files ...` is the form.
    for (const match of line.matchAll(/node (?:test|ace)\.js\s+--suite\s+(\S+)/g)) {
      findings.push(
        `${entry}:${index + 1}  --suite ${match[1]}  is not a suite selector — write the suite positionally: \`node test.js ${match[1]} ...\``
      )
    }
    for (const match of line.matchAll(/--files[= ]+('[^']*'|"[^"]*"|\S+)/g)) {
      const value = match[1].replace(/^['"]|['"]$/g, '')
      if (value.includes('*')) continue
      const directories = SUITES.map((s) => `tests/${s}/${value}`).filter(isDirectory)
      if (directories.length) {
        findings.push(`${entry}:${index + 1}  --files ${value}  names ${directories.join(', ')} — use '${value}/*'`)
      }
    }
  })
}

if (findings.length) {
  console.error(`${findings.length} workflow test filter(s) name a directory and match no tests:`)
  for (const finding of findings) console.error(`  ${finding}`)
  process.exit(1)
}
console.log('workflow test filters: every --files value resolves to files, not a directory')
