import { lstat, readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { FixtureEntry } from '#tests/helpers/git_fixtures'

/**
 * The lookalikes fixture (WP-19): benign content the guards are likely to
 * flag. Files are read as bytes so the encoding set (CRLF, BOM, UTF-16, no
 * final newline) reaches the repository exactly as the generator wrote it;
 * the symlink and the submodule declaration are carried as such.
 */
export const LOOKALIKES_FIXTURE = 'evals/fixtures/lookalikes'

/** A pinned gitlink for the declared submodule; the fixture server never serves it. */
const SUBMODULE_SHA = '0123456789abcdef0123456789abcdef01234567'

export async function lookalikeEntries(): Promise<Record<string, FixtureEntry>> {
  const entries: Record<string, FixtureEntry> = {}
  for (const entry of await readdir(LOOKALIKES_FIXTURE, { recursive: true })) {
    if (entry === 'README.md' || entry === 'generate.py') continue
    const full = join(LOOKALIKES_FIXTURE, entry)
    const stat = await lstat(full)
    if (stat.isSymbolicLink()) entries[entry] = { symlink: await readlink(full) }
    else if (stat.isFile()) entries[entry] = await readFile(full)
  }
  entries['vendor/shared'] = { gitlink: SUBMODULE_SHA }
  return entries
}
