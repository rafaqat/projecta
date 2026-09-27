import type { GitRunner } from '#app/ingest/git_runner'

/**
 * Reads a commit straight from the object database (SEC-01): the
 * tree via `ls-tree -r -z`, contents via `cat-file --batch`. No working tree
 * ever exists, so a symlink is just a blob holding its target path and a
 * gitlink is an entry with no content.
 */
export interface TreeEntry {
  mode: string
  type: 'blob' | 'commit' | 'tree'
  sha: string
  path: string
}

export const MODE_SYMLINK = '120000'
export const MODE_GITLINK = '160000'

/** `-z` output separates records with NUL, which keeps paths with newlines intact. */
const NUL = String.fromCharCode(0)

export async function listTree(runner: GitRunner, commitSha: string): Promise<TreeEntry[]> {
  const out = await runner.run(['ls-tree', '-r', '-z', '--end-of-options', commitSha])
  const entries: TreeEntry[] = []
  for (const record of out.toString('utf8').split(NUL)) {
    if (!record) continue
    const tab = record.indexOf('\t')
    const [mode, type, sha] = record.slice(0, tab).split(' ')
    entries.push({ mode, type: type as TreeEntry['type'], sha, path: record.slice(tab + 1) })
  }
  return entries
}

export async function blobSizes(runner: GitRunner, shas: string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>()
  if (shas.length === 0) return sizes
  const out = await runner.run(
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    shas.join('\n') + '\n'
  )
  for (const line of out.toString('utf8').split('\n')) {
    const [sha, type, size] = line.split(' ')
    if (type === 'blob') sizes.set(sha, Number(size))
  }
  return sizes
}

/** Reads the requested blobs in one `cat-file --batch` process. */
export async function readBlobs(runner: GitRunner, shas: string[]): Promise<Map<string, Buffer>> {
  const blobs = new Map<string, Buffer>()
  if (shas.length === 0) return blobs
  const out = await runner.run(['cat-file', '--batch'], shas.join('\n') + '\n')
  let offset = 0
  while (offset < out.length) {
    const newline = out.indexOf(0x0a, offset)
    if (newline === -1) break
    const header = out.subarray(offset, newline).toString('utf8')
    const [sha, type, sizeText] = header.split(' ')
    if (type === 'missing' || sizeText === undefined) {
      offset = newline + 1
      continue
    }
    const size = Number(sizeText)
    const start = newline + 1
    blobs.set(sha, Buffer.from(out.subarray(start, start + size)))
    offset = start + size + 1
  }
  return blobs
}
