/**
 * Parser child process entrypoint (SEC-01, SEC-19). Runs with no
 * secrets in its environment, as a non-root user on a read-only filesystem
 * with tmpfs scratch (docker/compose.yml). It speaks JSON lines on stdio;
 * only the parent writes to the database. `parse` runs tree-sitter with the
 * per-file timeout the parent asks for.
 */
import { createInterface } from 'node:readline'
import { symbolTokens, type SymbolTokens } from '#app/clones/tokens'
import { extractAllDependencies } from '#app/dependencies/extractor'
import { extractSurface } from '#app/dependencies/surface'
import { extractEndpoints } from '#app/parse/extractors/endpoints'
import { parseSource } from '#app/parse/parser'
import { extractSwiftFacts, type ParsedSwiftFile } from '#app/parse/profiles/swift_facts'
import { extractKotlinFacts, type ParsedKotlinFile } from '#app/parse/profiles/kotlin_facts'

interface Message {
  type?: string
  id?: string
  path?: string
  content?: string
  timeoutMs?: number
  files?: Record<string, string>
}

/** The Extract step (design §4) runs here too: endpoints, dependencies and Swift and Kotlin facts over hostile source. */
async function extract(files: Record<string, string>, timeoutMs: number) {
  const swift: ParsedSwiftFile[] = []
  const kotlin: ParsedKotlinFile[] = []
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith('.swift') && !path.endsWith('.kt')) continue
    const result = await parseSource({ path, content, timeoutMs })
    if (result.status !== 'ok') continue
    ;(path.endsWith('.kt') ? kotlin : swift).push({ path, symbols: result.symbols })
  }
  const android = Object.keys(files).some((p) => p.endsWith('AndroidManifest.xml'))
  const { dependencies, manifests } = await extractAllDependencies(files)
  return {
    endpoints: await extractEndpoints(files),
    dependencies,
    manifests,
    swiftFacts:
      swift.length || files['Package.swift'] ? await extractSwiftFacts(files, swift) : null,
    kotlinFacts: kotlin.length || android ? await extractKotlinFacts(files, kotlin) : null,
  }
}

const reply = (message: Record<string, unknown>) =>
  process.stdout.write(JSON.stringify(message) + '\n')

const lines = createInterface({ input: process.stdin })
lines.on('line', async (line) => {
  let message: Message
  try {
    message = JSON.parse(line)
  } catch {
    reply({ type: 'error', error: 'invalid_json' })
    return
  }
  if (message.type === 'ping') {
    reply({
      type: 'pong',
      id: message.id,
      env: Object.keys(process.env).sort(),
      uid: process.getuid?.(),
    })
  } else if (
    message.type === 'parse' &&
    typeof message.path === 'string' &&
    typeof message.content === 'string'
  ) {
    // A pathological file (e.g. minified with a very deep call/member chain) can throw RangeError
    // from the recursive AST walk. Catch it like the extract/clones siblings so a throw becomes a
    // clean skip, not an unhandled rejection that SIGKILLs the child and fires a false
    // error.unhandled alert; the pool already treats 'timeout' as "couldn't parse, move on".
    const result = await parseSource({
      path: message.path,
      content: message.content,
      timeoutMs: message.timeoutMs ?? 5000,
    }).catch(() => ({ status: 'timeout' as const }))
    reply({ type: 'parsed', id: message.id, result })
  } else if (message.type === 'extract' && message.files && typeof message.files === 'object') {
    // An extractor failing on hostile input yields empty tables; the child stays up for the next file.
    const result = await extract(message.files, message.timeoutMs ?? 5000).catch(() => ({
      endpoints: [],
      dependencies: [],
      swiftFacts: null,
      kotlinFacts: null,
    }))
    reply({ type: 'extracted', id: message.id, result })
  } else if (message.type === 'clones' && message.files && typeof message.files === 'object') {
    // Clone normalisation tokens per declaration (design §7); hostile files yield nothing.
    const result: SymbolTokens[] = []
    for (const [path, content] of Object.entries(message.files))
      result.push(...(await symbolTokens(path, content).catch(() => [])))
    reply({ type: 'cloned', id: message.id, result })
  } else if (message.type === 'surface' && message.files && typeof message.files === 'object') {
    reply({
      type: 'surfaced',
      id: message.id,
      result: await extractSurface(new Map(Object.entries(message.files))),
    })
  } else {
    reply({ type: 'error', id: message.id, error: 'unsupported' })
  }
})
lines.on('close', () => process.exit(0))
