import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EvalCase, Tier } from './types.ts'

const here = dirname(fileURLToPath(import.meta.url))
const CASES_ROOT = join(here, '..', 'cases')
const TIERS: Tier[] = ['correctness', 'robustness', 'adversarial']

async function readJsonFiles(dir: string): Promise<unknown[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const out: unknown[] = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    out.push(JSON.parse(await readFile(join(dir, name), 'utf8')))
  }
  return out
}

export interface LoadedTier {
  tier: Tier
  cases: EvalCase[]
  labelled: EvalCase[]
  pending: EvalCase[]
}

/** Loads every case, splitting the human-labelled (counted) from the pending (labelled_by: null). */
export async function loadCases(): Promise<LoadedTier[]> {
  const result: LoadedTier[] = []
  for (const tier of TIERS) {
    const raw = (await readJsonFiles(join(CASES_ROOT, tier))) as EvalCase[]
    const cases = raw.filter((c) => c && c.tier === tier)
    const labelled = cases.filter((c) => c.labelled_by !== null && c.labelled_by !== undefined)
    const pending = cases.filter((c) => c.labelled_by === null || c.labelled_by === undefined)
    result.push({ tier, cases, labelled, pending })
  }
  return result
}
