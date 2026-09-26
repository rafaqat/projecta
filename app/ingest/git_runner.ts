import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Git configuration applied to every invocation (SEC-03): no
 * transport but HTTPS, no redirects, no submodules, no LFS smudge.
 */
export const HARDENED_GIT_CONFIG: Record<string, string> = {
  'protocol.allow': 'never',
  'protocol.https.allow': 'always',
  'http.followRedirects': 'false',
  'fetch.recurseSubmodules': 'no',
  'core.hooksPath': '/dev/null',
  'uploadpack.allowAnySHA1InWant': 'false',
}

/** Environment variables the child may inherit; everything else is dropped. */
const ENV_PASSTHROUGH = [
  'PATH',
  'HOME',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'GIT_SSL_CAINFO',
  'TMPDIR',
]

/** A git failure with the exit code, or the signal that ended it (a timeout kills the child). */
export type GitError = Error & { code?: number | null; signal?: NodeJS.Signals | null }

/** The step's failure codes: recorded with a correlation, never swallowed. */
export type HistoryFetchCode =
  'COCHANGE_FILTER_REFUSED' | 'COCHANGE_TIMEOUT' | 'COCHANGE_GIT_FAILED'

export class HistoryFetchError extends Error {
  constructor(
    readonly code: HistoryFetchCode,
    message: string,
    cause?: unknown
  ) {
    super(`${code}: ${message}`, { cause })
    this.name = 'HistoryFetchError'
  }
}

/** A full object id, SHA-1 or SHA-256, lowercase: the only commit form that reaches a git command. */
export const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const HISTORY_WINDOW_MAX = 10_000
/** Keys a filtered fetch writes that let git fetch missing objects later. */
const PROMISOR_KEY = 'promisor|partialclone'

export interface GitRunnerOptions {
  cwd: string
  git?: string
  timeoutMs?: number
}

/**
 * A ref name is safe when git itself accepts it and it cannot be mistaken
 * for an option (SEC-33). Names starting with "-" are refused outright, and
 * `check-ref-format` validates the fully qualified `refs/heads/<name>`, so
 * the candidate is never the first character of an argument.
 */
export async function isSafeRefName(ref: string): Promise<boolean> {
  if (!ref || ref.startsWith('-') || ref.includes('\0')) return false
  try {
    await execFileAsync('git', ['check-ref-format', `refs/heads/${ref}`], { timeout: 5000 })
    return true
  } catch (error) {
    // Only git's own verdict (a non-zero exit) means "unsafe". A missing or
    // failing git binary is an error and is never presented as bad input.
    if (typeof (error as { code?: unknown }).code === 'number') return false
    throw error
  }
}

export class GitRunner {
  constructor(private readonly options: GitRunnerOptions) {}

  /** The bare repository's directory. */
  get cwd(): string {
    return this.options.cwd
  }

  private get git() {
    return this.options.git ?? 'git'
  }

  private configArgs(): string[] {
    return Object.entries(HARDENED_GIT_CONFIG).flatMap(([key, value]) => ['-c', `${key}=${value}`])
  }

  /** Only allowlisted variables reach git; no secret can leak through a helper or hook. */
  childEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }
    for (const name of ENV_PASSTHROUGH) {
      const value = source[name]
      if (value !== undefined) env[name] = value
    }
    // A missing object is an error, never a network fetch, whatever a repository's config says
    // (git ≥ 2.44). Set last so no inherited value can turn it off.
    env.GIT_NO_LAZY_FETCH = '1'
    return env
  }

  /**
   * The tip fetch. A pinned commit is fetched by id into the same local ref, so every
   * later step reads it exactly as it reads a branch; without a pin, the branch as before — some
   * servers refuse a want that is not a ref tip, so a branch ingest never depends on that.
   */
  fetchArgs(url: string, ref: string, commit?: string): string[] {
    return [
      ...this.configArgs(),
      'fetch',
      '--no-tags',
      '--no-recurse-submodules',
      '--depth=1',
      '--end-of-options',
      url,
      `+${commit ?? `refs/heads/${ref}`}:refs/heads/${ref}`,
    ]
  }

  /**
   * History without contents: the same ref, `window` commits deep, no blobs.
   * Run only after the tip fetch, and followed at once by `fetchHistory`'s cleanup.
   */
  historyFetchArgs(url: string, ref: string, window: number, commit?: string): string[] {
    if (!Number.isInteger(window) || window < 1 || window > HISTORY_WINDOW_MAX)
      throw new Error(`history window must be an integer from 1 to ${HISTORY_WINDOW_MAX}`)
    return [
      ...this.configArgs(),
      'fetch',
      '--no-tags',
      '--no-recurse-submodules',
      '--filter=blob:none',
      `--depth=${window}`,
      '--end-of-options',
      url,
      `+${commit ?? `refs/heads/${ref}`}:refs/heads/${ref}`,
    ]
  }

  /**
   * The one history read allows: commit identities and changed paths. No author,
   * committer, date or message placeholder may be added without amending the ADR.
   */
  historyLogArgs(commit: string): string[] {
    if (!COMMIT_SHA.test(commit)) throw new Error('history log needs a full commit SHA')
    return [
      'log',
      '--first-parent',
      '--no-merges',
      '--no-renames',
      '--name-only',
      '-z',
      '--format=%x00%H',
      '--end-of-options',
      commit,
    ]
  }

  /**
   * Fetches history without contents and leaves the repository unable to fetch anything more
   *: the promisor configuration the filtered fetch writes is removed —
   * also when the fetch fails — and every blob in the object database must belong to the
   * indexed commit's tree, or the host ignored the filter. Errors are coded, never swallowed.
   */
  async fetchHistory(
    url: string,
    ref: string,
    commit: string,
    window: number,
    /** Fetch the history behind this commit by id rather than behind the branch. */
    pinned = false
  ): Promise<{ commits: number }> {
    if (!(await isSafeRefName(ref)))
      throw new Error(`unsafe ref name rejected: ${JSON.stringify(ref)}`)
    if (!COMMIT_SHA.test(commit)) throw new Error('history fetch needs a full commit SHA')
    try {
      await this.run(this.historyFetchArgs(url, ref, window, pinned ? commit : undefined))
    } catch (error) {
      await this.removePromisor()
      throw new HistoryFetchError(
        (error as GitError).signal ? 'COCHANGE_TIMEOUT' : 'COCHANGE_GIT_FAILED',
        'history fetch failed',
        error
      )
    }
    await this.removePromisor()

    const listing = await this.run([
      'cat-file',
      '--batch-all-objects',
      '--batch-check=%(objecttype) %(objectname)',
    ])
    const objects = listing
      .toString()
      .split('\n')
      .filter((line) => line.startsWith('blob '))
      .map((line) => line.slice('blob '.length))
    const entries = await this.run(['ls-tree', '-r', '-z', '--end-of-options', commit])
    const tree = new Set(
      entries
        .toString()
        .split('\0')
        .filter(Boolean)
        .map((entry) => entry.split('\t')[0].split(' '))
        .filter(([, type]) => type === 'blob')
        .map(([, , sha]) => sha)
    )
    const foreign = objects.filter((sha) => !tree.has(sha)).length
    if (foreign > 0)
      throw new HistoryFetchError(
        'COCHANGE_FILTER_REFUSED',
        `the host sent ${foreign} blob(s) outside the indexed tree`
      )
    const count = await this.run(['rev-list', '--count', '--end-of-options', commit])
    return { commits: Number(count.toString().trim()) }
  }

  /** Removes every promisor and partial-clone key, then proves none is left. */
  private async removePromisor(): Promise<void> {
    const keys = await this.run(['config', '--local', '--name-only', '--get-regexp', PROMISOR_KEY])
      .then((out) => out.toString().split('\n').filter(Boolean))
      .catch((error: GitError) => {
        if (error.code === 1) return [] // no matching key
        throw error
      })
    const sections = new Set<string>()
    for (const key of keys) {
      if (key.startsWith('remote.')) sections.add(key.slice(0, key.lastIndexOf('.')))
      else await this.run(['config', '--local', '--unset-all', key])
    }
    for (const section of sections)
      await this.run(['config', '--local', '--remove-section', section])
    const left = await this.run(['config', '--local', '--name-only', '--list'])
    if (new RegExp(PROMISOR_KEY, 'i').test(left.toString()))
      throw new HistoryFetchError(
        'COCHANGE_GIT_FAILED',
        'promisor configuration could not be removed'
      )
  }

  /** Runs git without a shell and returns stdout as a buffer. */
  run(args: string[], input?: Buffer | string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child: ChildProcess = spawn(this.git, args, {
        cwd: this.options.cwd,
        env: this.childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: this.options.timeoutMs ?? 120_000,
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
      child.stderr?.on('data', (chunk: Buffer) => err.push(chunk))
      child.on('error', reject)
      child.on('close', (code, signal) => {
        if (code === 0) return resolve(Buffer.concat(out))
        const error: GitError = new Error(
          `git ${args[args.indexOf('--end-of-options') - 1] ?? args[0]} failed (${code ?? signal}): ${Buffer.concat(err).toString().slice(0, 500)}`
        )
        error.code = code
        error.signal = signal
        reject(error)
      })
      if (input !== undefined) child.stdin?.end(input)
      else child.stdin?.end()
    })
  }

  async init(): Promise<void> {
    await this.run(['init', '--bare', '--quiet'])
  }

  /**
   * The remote's default branch, from the symref line `git ls-remote --symref`
   * prints for HEAD. One bounded network call through the same hardened
   * config as fetch; the name still has to pass the ref-name check before it
   * is fetched.
   */
  async defaultBranch(url: string): Promise<string> {
    const out = await this.run([
      ...this.configArgs(),
      'ls-remote',
      '--symref',
      '--end-of-options',
      url,
      'HEAD',
    ])
    const branch = parseDefaultBranch(out.toString())
    if (!(await isSafeRefName(branch)))
      throw new Error(`unsafe ref name rejected: ${JSON.stringify(branch)}`)
    return branch
  }

  async fetch(url: string, ref: string, commit?: string): Promise<void> {
    if (!(await isSafeRefName(ref)))
      throw new Error(`unsafe ref name rejected: ${JSON.stringify(ref)}`)
    if (commit !== undefined && !COMMIT_SHA.test(commit))
      throw new Error('commit id must be a full lowercase object id')
    await this.run(this.fetchArgs(url, ref, commit))
  }

  async resolveRef(ref: string): Promise<string> {
    if (!(await isSafeRefName(ref)))
      throw new Error(`unsafe ref name rejected: ${JSON.stringify(ref)}`)
    const out = await this.run([
      'rev-parse',
      '--verify',
      '--end-of-options',
      `refs/heads/${ref}^{commit}`,
    ])
    return out.toString().trim()
  }
}

/** `ref: refs/heads/<name>\tHEAD` from ls-remote --symref; the branch name, or an error. */
export function parseDefaultBranch(output: string): string {
  const line = output
    .split('\n')
    .find((l) => l.startsWith('ref: refs/heads/') && l.endsWith('\tHEAD'))
  const name = line?.slice('ref: refs/heads/'.length, -'\tHEAD'.length)
  if (!name) throw new Error('the remote did not name a default branch under refs/heads')
  return name
}
