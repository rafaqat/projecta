import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCases } from './load.ts'
import { runTier } from './runners.ts'
import { renderReport, ratchet } from './report.ts'
import type { RunReport } from './types.ts'

const here = dirname(fileURLToPath(import.meta.url))
const EVALS = join(here, '..')

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const loaded = await loadCases()
  const report: RunReport = {
    generatedAt: new Date().toISOString(),
    tiers: await Promise.all(loaded.map(runTier)),
  }

  console.log(renderReport(report))

  await mkdir(join(EVALS, 'runs'), { recursive: true })
  await writeFile(join(EVALS, 'runs', 'latest.json'), JSON.stringify(report, null, 2) + '\n')

  const baseline = await readJson<RunReport>(join(EVALS, 'baselines', 'baseline.json'))
  const { regressions } = ratchet(report, baseline)

  const pending = report.tiers.reduce((n, t) => n + t.pending, 0)
  const unmet = report.tiers.reduce((n, t) => n + t.metrics.filter((m) => !m.met).length, 0)

  console.log('')
  console.log(`target: ${unmet} metric(s) not yet met — the work each slice makes green.`)
  console.log(`labels: ${pending} case(s) awaiting a human label (labelled_by: null).`)

  if (regressions.length > 0) {
    console.log('')
    console.log('RATCHET FAILED — a metric regressed below the accepted baseline:')
    for (const r of regressions) console.log(`  - ${r}`)
    process.exitCode = 1
    return
  }
  // Target mode: unmet targets are warnings, not failures, so a legitimately-red early slice is
  // still mergeable — the merge whose job is to turn a metric green cannot be blocked by it.
  console.log('ratchet: ok (no regression against baseline).')
  process.exitCode = 0
}

main().catch((err) => {
  console.error('eval harness error:', err)
  process.exitCode = 2
})
