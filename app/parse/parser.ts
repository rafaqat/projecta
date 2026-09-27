import { createRequire } from 'node:module'
import { dirname, extname, join } from 'node:path'
import { Language, Parser, type Node } from 'web-tree-sitter'
import { extractNodeSymbols, type ParsedSymbol } from '#app/parse/profiles/node_symbols'
import {
  defaultExportOf,
  extractNodeReferences,
  type NodeFacts,
  type ParsedReference,
} from '#app/parse/profiles/node_references'
import { extractJsonSymbols } from '#app/parse/profiles/json_regions'
import { extractMarkdownSymbols } from '#app/parse/profiles/markdown_regions'
import { extractTemplateRegions } from '#app/parse/profiles/template_regions'
import { extractSwiftSymbols } from '#app/parse/profiles/swift_symbols'
import { extractSwiftReferences } from '#app/parse/profiles/swift_references'
import {
  extractGradleScriptRegions,
  extractKotlinSymbols,
} from '#app/parse/profiles/kotlin_symbols'
import { extractKotlinReferences } from '#app/parse/profiles/kotlin_references'

/**
 * Tree-sitter parsing. Grammars are WebAssembly files
 * shipped by @vscode/tree-sitter-wasm and loaded once per process; parsing
 * is bounded by a per-file timeout that tree-sitter enforces itself, so a
 * pathological file yields `timeout` instead of a stuck worker.
 */
export type GrammarId =
  'javascript' | 'typescript' | 'tsx' | 'swift' | 'kotlin' | 'json' | 'markdown' | 'template'

const EXTENSIONS: Record<string, GrammarId> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.json': 'json',
  '.md': 'markdown',
  '.markdown': 'markdown',
  // Templates and markup: text regions, no grammar.
  ...Object.fromEntries(
    [
      '.hbs',
      '.handlebars',
      '.mustache',
      '.ejs',
      '.pug',
      '.jade',
      '.njk',
      '.nunjucks',
      '.liquid',
      '.twig',
      '.erb',
      '.html',
      '.htm',
      '.vue',
      '.svelte',
      '.astro',
    ].map((ext) => [ext, 'template' as const])
  ),
}

/** Grammars read by a linear scanner, with no syntax tree: no references, no clones (WP-19). */
export const SCANNER_GRAMMARS: ReadonlySet<GrammarId> = new Set(['json', 'markdown', 'template'])

/** Lockfiles are generated and enormous: stored, never parsed as JSON content. */
const GENERATED_JSON = /(^|\/)(package-lock|npm-shrinkwrap)\.json$/

export function grammarFor(path: string): GrammarId | null {
  if (GENERATED_JSON.test(path)) return null
  return EXTENSIONS[extname(path)] ?? null
}

const require = createRequire(import.meta.url)
const grammarDir = join(dirname(require.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm')
/** Grammars outside the npm package are pinned by SHA-256 in models.lock.json and fetched at build. */
const PINNED_GRAMMARS: Partial<Record<GrammarId, string>> = {
  swift: join(process.env.MODELS_DIR ?? 'models', 'grammars', 'tree-sitter-swift.wasm'),
  kotlin: join(process.env.MODELS_DIR ?? 'models', 'grammars', 'tree-sitter-kotlin.wasm'),
}

let initialised: Promise<void> | undefined
const languages = new Map<GrammarId, Promise<Language>>()

async function language(id: GrammarId): Promise<Language> {
  initialised ??= Parser.init()
  await initialised
  let loading = languages.get(id)
  if (!loading) {
    loading = Language.load(PINNED_GRAMMARS[id] ?? join(grammarDir, `tree-sitter-${id}.wasm`))
    languages.set(id, loading)
  }
  return loading
}

export interface ParseRequest {
  path: string
  content: string
  timeoutMs: number
}

export type ParseResult =
  | {
      status: 'ok'
      grammar: GrammarId
      symbols: ParsedSymbol[]
      /** References; Swift names module-level targets for the link pass. */
      references: ParsedReference[]
      /** The symbol `export default` names, for imports of this module to resolve to. */
      defaultExport: string | null
      /** What each function returns when it is an external type the receiver table names. */
      returnTypes: Record<string, { module: string; type: string }>
      hasErrors: boolean
    }
  | { status: 'timeout' }
  | { status: 'unsupported' }

/** Runs `fn` over the syntax tree of one file and frees it; null when the language is unsupported or parsing timed out. */
export async function withTree<T>(
  request: ParseRequest,
  fn: (root: Node, grammar: GrammarId) => T
): Promise<T | null> {
  const grammar = grammarFor(request.path)
  if (!grammar || SCANNER_GRAMMARS.has(grammar)) return null // no syntax tree: scanner profiles only
  const loaded = await language(grammar)
  const parser = new Parser()
  parser.setLanguage(loaded)
  const started = performance.now()
  const tree = parser.parse(request.content, undefined, {
    progressCallback: () => performance.now() - started > request.timeoutMs,
  })
  try {
    return tree ? fn(tree.rootNode, grammar) : null
  } finally {
    tree?.delete()
    parser.delete()
  }
}

export async function parseSource(request: ParseRequest): Promise<ParseResult> {
  const grammar = grammarFor(request.path)
  if (!grammar) return { status: 'unsupported' }
  // JSON and Markdown have no grammar here: scanners yield one symbol per top-level key
  // (WP-19) and one region per heading section (prose for "what does this repository do").
  if (SCANNER_GRAMMARS.has(grammar))
    return {
      status: 'ok',
      grammar,
      symbols:
        grammar === 'json'
          ? extractJsonSymbols(request.content)
          : grammar === 'markdown'
            ? extractMarkdownSymbols(request.content)
            : extractTemplateRegions(request.content),
      references: [],
      defaultExport: null,
      returnTypes: {},
      hasErrors: false,
    }
  const loaded = await language(grammar)
  const parser = new Parser()
  parser.setLanguage(loaded)
  const started = performance.now()
  const tree = parser.parse(request.content, undefined, {
    progressCallback: () => performance.now() - started > request.timeoutMs,
  })
  try {
    if (!tree) return { status: 'timeout' }
    const root: Node = tree.rootNode
    const symbols =
      grammar === 'swift'
        ? extractSwiftSymbols(root)
        : grammar === 'kotlin'
          ? request.path.endsWith('.kts')
            ? extractGradleScriptRegions(root)
            : extractKotlinSymbols(root)
          : extractNodeSymbols(root, request.content)
    const facts: NodeFacts = { returnTypes: new Map() }
    const references =
      grammar === 'swift'
        ? /(^|\/)Package\.swift$/.test(request.path) // a manifest, not a source of references
          ? []
          : extractSwiftReferences(root, symbols)
        : grammar === 'kotlin'
          ? request.path.endsWith('.kts') // a Gradle script is a manifest, not a source of references
            ? []
            : extractKotlinReferences(root, symbols)
          : extractNodeReferences(root, symbols, facts)
    return {
      status: 'ok',
      grammar,
      symbols,
      references,
      defaultExport: grammar === 'swift' || grammar === 'kotlin' ? null : defaultExportOf(root),
      returnTypes: Object.fromEntries(facts.returnTypes),
      hasErrors: root.hasError,
    }
  } finally {
    tree?.delete()
    parser.delete()
  }
}
