import { spawn, type ChildProcess } from 'node:child_process'
import logger from '@adonisjs/core/services/logger'
import { createHash } from 'node:crypto'
import { securityEvents } from '#app/security/events/index'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

/** The compiled child in a build; the TypeScript source under the dev and test loaders. */
function defaultEntry(): string {
  const compiled = fileURLToPath(new URL('./child.js', import.meta.url))
  return existsSync(compiled) ? compiled : fileURLToPath(new URL('./child.ts', import.meta.url))
}

const TS_LOADER = '@poppinss/ts-exec'

/**
 * The child's node arguments. A compiled entry (every built image) needs none beyond the parent's.
 * A TypeScript entry needs the loader that maps its `.js` imports to `.ts` sources: `node ace test`
 * passes it on the command line, but `ace.js` registers it in process for every other command, so
 * an ace command's `execArgv` has none — and a child without it strips types, fails its first
 * import, and never answers (every file timed out on WP-24's first real run).
 */
export function childArgs(entry: string, execArgv: string[]): string[] {
  const hasLoader = execArgv.some((arg) => arg.includes(TS_LOADER))
  const loader = entry.endsWith('.ts') && !hasLoader ? ['--import', TS_LOADER] : []
  return [...execArgv, ...loader, entry]
}

/** Only these variables reach the parser; no credential is ever among them. */
const PARSER_ENV_PASSTHROUGH = ['PATH', 'TMPDIR', 'NODE_OPTIONS', 'MODELS_DIR']

export function parserEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of PARSER_ENV_PASSTHROUGH) {
    if (source[name] !== undefined) env[name] = source[name]!
  }
  return env
}

/**
 * Spawns the parser child with a minimal environment and a JSON-lines
 * channel. The parent owns every database write.
 */
export class ParserChild {
  private readonly child: ChildProcess
  private readonly pending = new Map<string, (message: Record<string, unknown>) => void>()
  private sequence = 0

  constructor(entry = defaultEntry()) {
    // The parent's loader flags (the TypeScript loader in dev and test; none in a build) are the only inheritance.
    this.child = spawn(process.execPath, childArgs(entry, process.execArgv), {
      env: parserEnv(),
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    createInterface({ input: this.child.stdout! }).on('line', (line) => {
      const message = JSON.parse(line) as Record<string, unknown>
      const resolve = this.pending.get(String(message.id))
      if (resolve) {
        this.pending.delete(String(message.id))
        resolve(message)
      }
    })
  }

  request(message: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const id = String(++this.sequence)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.child.kill('SIGKILL')
        reject(new Error(`parser child did not answer within ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, (reply) => {
        clearTimeout(timer)
        resolve(reply)
      })
      this.child.stdin!.write(JSON.stringify({ ...message, id }) + '\n')
    })
  }

  get alive(): boolean {
    return this.child.exitCode === null && !this.child.killed
  }

  close(): void {
    if (this.alive) this.child.stdin!.end()
  }
}

import type { ParseResult } from '#app/parse/parser'
import type { SymbolTokens } from '#app/clones/tokens'
import type { DependencyFact } from '#app/dependencies/extractor'
import type { ManifestRecord } from '#app/dependencies/manifests'
import type { SurfaceSymbol } from '#app/dependencies/surface'
import type { Endpoint } from '#app/parse/extractors/endpoints'
import type { SwiftRepoFacts } from '#app/parse/profiles/swift_facts'
import type { KotlinRepoFacts } from '#app/parse/profiles/kotlin_facts'

export interface ExtractResult {
  endpoints: Endpoint[]
  dependencies: DependencyFact[]
  manifests: ManifestRecord[]
  swiftFacts: SwiftRepoFacts | null
  kotlinFacts: KotlinRepoFacts | null
}

/**
 * Parses one file in the child; a child that hangs past twice the file's
 * timeout is killed and replaced, and the file is recorded as timed out.
 */
export class ParserPool {
  private child: ParserChild | undefined

  constructor(private readonly entry?: string) {}

  async parse(path: string, content: string, timeoutMs: number): Promise<ParseResult> {
    if (!this.child?.alive) this.child = new ParserChild(this.entry)
    try {
      const reply = await this.child.request(
        { type: 'parse', path, content, timeoutMs },
        timeoutMs * 2 + 5000
      )
      return reply.result as ParseResult
    } catch (error) {
      // Named (never swallowed): the file is out of the index and the parse cache; the indexer
      // logs it per file, this names the child failure itself.
      reportChildFailure('parse', error, { path })
      this.child = undefined
      return { status: 'timeout' }
    }
  }

  /** Runs the extractors over a whole commit's sources in the child; a hang yields empty tables. */
  async extract(files: Record<string, string>, timeoutMs: number): Promise<ExtractResult> {
    if (!this.child?.alive) this.child = new ParserChild(this.entry)
    try {
      const reply = await this.child.request(
        { type: 'extract', files, timeoutMs },
        timeoutMs * 20 + 5000
      )
      return reply.result as ExtractResult
    } catch (error) {
      // Empty tables would read as "no endpoints, no dependencies": the failure is named.
      reportChildFailure('extract', error, { files: Object.keys(files).length })
      this.child = undefined
      return { endpoints: [], dependencies: [], manifests: [], swiftFacts: null, kotlinFacts: null }
    }
  }

  /** Clone tokens for every declaration of a commit, produced in the child. */
  async clones(files: Record<string, string>, timeoutMs: number): Promise<SymbolTokens[]> {
    if (!this.child?.alive) this.child = new ParserChild(this.entry)
    try {
      const reply = await this.child.request(
        { type: 'clones', files, timeoutMs },
        timeoutMs * 20 + 5000
      )
      return reply.result as SymbolTokens[]
    } catch (error) {
      reportChildFailure('tokens', error, {})
      this.child = undefined
      return []
    }
  }

  /** Tier 1 `.d.ts` surface, parsed in the child because dependency text is untrusted (SEC-04). */
  async surface(files: Record<string, string>, timeoutMs: number): Promise<SurfaceSymbol[]> {
    if (!this.child?.alive) this.child = new ParserChild(this.entry)
    try {
      const reply = await this.child.request(
        { type: 'surface', files, timeoutMs },
        timeoutMs * 20 + 5000
      )
      return reply.result as SurfaceSymbol[]
    } catch (error) {
      reportChildFailure('tokens', error, {})
      this.child = undefined
      return []
    }
  }

  close(): void {
    this.child?.close()
    this.child = undefined
  }
}

/** The failure's class or code, never its message (which can carry source text). */
function reasonOf(error: unknown): string {
  const e = error as { code?: unknown; name?: unknown }
  return typeof e?.code === 'string' ? e.code : typeof e?.name === 'string' ? e.name : 'unknown'
}

/**
 * A child that hung or died is a failure of the system, never an empty result: the
 * `error.unhandled` event (allowlisted, alerted) carries the code; the log line carries the step.
 */
function reportChildFailure(step: string, error: unknown, detail: Record<string, unknown>): void {
  const reason = reasonOf(error)
  const message = error instanceof Error ? error.message : String(error)
  securityEvents.emit('error.unhandled', {
    errorCode: 'E_PARSER_CHILD',
    errorHash: createHash('sha256').update(`${step}:${message}`).digest('hex').slice(0, 16),
  })
  logger.warn({ code: 'E_PARSER_CHILD', step, reason, ...detail }, 'parser child failed')
}
