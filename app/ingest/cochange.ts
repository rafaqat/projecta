/**
 * Files that change together (§2–3), computed from the one history
 * read allows: commit SHAs and changed paths, first parent, no
 * merges, no renames. Nothing here sees an author, a date, a message or a
 * blob. The window and thresholds are configuration: the `no_cochange`
 * ablation (§6) tunes them, not argument.
 */
export const COCHANGE_CONFIG = {
  /** Commits of first-parent history fetched and read. */
  windowCommits: 500,
  /** A commit changing more paths is formatting, vendoring or a mass rename: skipped and counted. */
  maxPaths: 30,
  /** A pair is kept only when changed together at least this often… */
  minTogether: 3,
  /** …and in at least this share of the rarer file's changes. */
  minRatio: 0.3,
  /** Companions kept per path, by `together`. */
  maxCompanions: 10,
} as const

export interface HistoryCommit {
  sha: string
  paths: string[]
}

export interface CochangePair {
  pathA: string
  pathB: string
  together: number
  changesA: number
  changesB: number
}

export interface CochangeResult {
  pairs: CochangePair[]
  commitsRead: number
  bulkSkipped: number
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** Code-unit order, the order `path_a < path_b` is checked in (`COLLATE "C"`), never a locale's. */
const byteOrder = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)

/**
 * Parses `git log -z --name-only --format=%x00%H` output: each record is `\0<sha>\0`, a
 * newline, then `\0`-terminated paths. A record boundary is the only empty token, so a path
 * that happens to look like a SHA is never taken for one.
 */
export function parseHistoryLog(output: Buffer | string): HistoryCommit[] {
  const tokens = output.toString('utf8').split('\0')
  const commits: HistoryCommit[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '' && SHA.test(tokens[i + 1] ?? '')) {
      commits.push({ sha: tokens[i + 1], paths: [] })
      i++
      continue
    }
    const path = token.replace(/^\n/, '')
    if (path && commits.length) commits[commits.length - 1].paths.push(path)
  }
  return commits
}

/**
 * Counts pairs over the commits. A shallow-boundary commit (its parent was not fetched) lists
 * its whole tree as changed and is skipped; a commit over `maxPaths` raw paths is skipped and
 * counted as bulk; only `indexed` paths — present at the commit, not ignored, not skipped by
 * ingest limits — are counted. Pairs are kept by's thresholds, at most `maxCompanions`
 * per path on both sides, ordered for stable rows.
 */
export function countCochanges(
  commits: HistoryCommit[],
  indexed: ReadonlySet<string>,
  shallow: ReadonlySet<string>,
  config: typeof COCHANGE_CONFIG = COCHANGE_CONFIG
): CochangeResult {
  const changes = new Map<string, number>()
  const together = new Map<string, number>()
  let commitsRead = 0
  let bulkSkipped = 0
  for (const commit of commits) {
    if (shallow.has(commit.sha)) continue
    commitsRead++
    const unique = [...new Set(commit.paths)]
    if (unique.length > config.maxPaths) {
      bulkSkipped++
      continue
    }
    const kept = unique.filter((p) => indexed.has(p)).sort()
    for (const path of kept) changes.set(path, (changes.get(path) ?? 0) + 1)
    for (let i = 0; i < kept.length; i++)
      for (let j = i + 1; j < kept.length; j++) {
        const key = `${kept[i]}\0${kept[j]}`
        together.set(key, (together.get(key) ?? 0) + 1)
      }
  }

  const candidates: CochangePair[] = []
  for (const [key, count] of together) {
    const [pathA, pathB] = key.split('\0')
    const changesA = changes.get(pathA)!
    const changesB = changes.get(pathB)!
    if (count < config.minTogether || count / Math.min(changesA, changesB) < config.minRatio)
      continue
    candidates.push({ pathA, pathB, together: count, changesA, changesB })
  }
  // Rank each path's companions by `together`, then by the other path; keep a pair only when it
  // is within the cap for both of its paths.
  const ranked = new Map<string, CochangePair[]>()
  for (const pair of candidates)
    for (const path of [pair.pathA, pair.pathB])
      ranked.set(path, [...(ranked.get(path) ?? []), pair])
  const withinCap = (path: string, pair: CochangePair) => {
    const other = (p: CochangePair) => (p.pathA === path ? p.pathB : p.pathA)
    const list = ranked
      .get(path)!
      .slice()
      .sort((x, y) => y.together - x.together || byteOrder(other(x), other(y)))
    return list.indexOf(pair) < config.maxCompanions
  }
  const pairs = candidates
    .filter((pair) => withinCap(pair.pathA, pair) && withinCap(pair.pathB, pair))
    .sort((x, y) => byteOrder(x.pathA, y.pathA) || byteOrder(x.pathB, y.pathB))
  return { pairs, commitsRead, bulkSkipped }
}
