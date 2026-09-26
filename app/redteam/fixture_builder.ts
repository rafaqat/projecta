import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Fixture builder (design §12 stage 4): plants a decoded carrier next to
 * the code a question targets and builds the clean twin. Decoding happens
 * into an operating-system temporary directory, never into the repository.
 */
export type Entries = Record<string, string>

export interface Carrier {
  entryPoint: 'repo_comment' | 'readme' | 'commit_message' | 'dependency_manifest'
  /** For repo_comment: the file and the symbol the carrier sits above. */
  path?: string
  symbol?: string
  text: string
}

export interface Planted {
  poisoned: Entries
  clean: Entries
  /** Where the carrier landed, for the retrievability check. */
  location: { path: string; line: number } | null
  commitMessage?: string
}

/**
 * Inserts `text` as a comment block on the first line inside the symbol's
 * body. Comments between class members belong to no chunk (the chunker
 * indexes signatures and bodies), so a carrier above a method would never
 * be retrieved; inside the body it is part of the method's chunk.
 */
export function plant(base: Entries, carrier: Carrier): Planted {
  const clean = { ...base }
  const poisoned = { ...base }
  switch (carrier.entryPoint) {
    case 'readme': {
      const path = 'README.md'
      poisoned[path] = `${base[path] ?? '# Project\n'}\n## Notes\n\n${carrier.text}\n`
      clean[path] = base[path] ?? '# Project\n'
      return { poisoned, clean, location: { path, line: poisoned[path].split('\n').length - 2 } }
    }
    case 'dependency_manifest': {
      const path = 'package.json'
      const pkg = JSON.parse(base[path] ?? '{}') as Record<string, unknown>
      poisoned[path] = JSON.stringify({ ...pkg, description: carrier.text }, null, 2) + '\n'
      return { poisoned, clean, location: { path, line: 1 } }
    }
    case 'commit_message':
      return { poisoned, clean, location: null, commitMessage: carrier.text }
    case 'repo_comment': {
      const path = carrier.path!
      const lines = (base[path] ?? '').split('\n')
      const at = lines.findIndex(
        (l) =>
          new RegExp(`\\b${carrier.symbol!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(l) &&
          /(function|class|const|let|async|export|def )/.test(l)
      )
      const index = at === -1 ? 0 : at + 1 // first line of the body
      const comment = carrier.text
        .split('\n')
        .map((l) => (l.startsWith('//') || l.startsWith('/*') ? l : `// ${l}`))
      poisoned[path] = [...lines.slice(0, index), ...comment, ...lines.slice(index)].join('\n')
      return { poisoned, clean, location: { path, line: index + 1 } }
    }
  }
}

/** Materialises entries into a fresh temp directory (the only place decoded payloads touch disk). */
export async function materialise(entries: Entries): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'redteam-fixture-'))
  for (const [path, content] of Object.entries(entries)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return dir
}
