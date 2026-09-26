import type { Node } from 'web-tree-sitter'
import { chunkWeight, MAX_CHUNK_CHARS } from '#app/parse/chunker'

/**
 * Symbol extraction for JavaScript and TypeScript. Symbols are the
 * anchoring unit (functions, methods, classes, interfaces, types, enums and
 * arrow functions bound to constants); statement-level blocks inside each
 * symbol are the citation unit; top-level statements that belong to no
 * symbol are grouped into file regions so routes and configuration can be
 * cited too. Line numbers are 1-based and inclusive.
 */
export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'region'
  /** A name a module binds by import; a binding, not a declaration: never chunked, never in a manifest. Its `parent` is the module specifier. */
  | 'import'
  // Swift profile additions (design §4)
  | 'struct'
  | 'protocol'
  | 'extension'
  | 'property'

export interface CitationBlock {
  startLine: number
  endLine: number
}

export interface ParsedSymbol {
  kind: SymbolKind
  name: string
  qualifiedName: string
  parent: string | null
  startLine: number
  endLine: number
  blocks: CitationBlock[]
  /**
   * The first line of the comment run that documents this declaration, when one sits immediately
   * above it. The chunker slices from here so the prose and the code it describes are
   * one retrieval unit; `startLine` still names the declaration, so the symbols table, the
   * outline and the golden symbol manifests are untouched.
   */
  docStartLine?: number
}

const DECLARATION_KINDS: Record<string, SymbolKind> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
}

const CLASS_MEMBER_KINDS = new Set([
  'method_definition',
  'method_signature',
  'public_field_definition',
])
const FUNCTION_VALUES = new Set([
  'arrow_function',
  'function_expression',
  'function',
  'generator_function',
])

function lines(node: Node): CitationBlock {
  return { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }
}

function nameOf(node: Node): string | null {
  const name = node.childForFieldName('name')
  return name?.text ?? null
}

const PATTERNS = new Set(['object_pattern', 'array_pattern'])

/** `import a from`, `import { b, c as d }`, `import * as e`: a, b, d, e. Type-only and bare imports bind nothing. */
function importBindings(statement: Node): string[] {
  const clause = statement.namedChildren.find((c) => c?.type === 'import_clause')
  // `import type { X }`: the keyword sits on the statement or on the clause, by grammar version.
  if ([...statement.children, ...(clause?.children ?? [])].some((c) => c?.type === 'type'))
    return []
  const out: string[] = []
  const walk = (node: Node) => {
    switch (node.type) {
      case 'import_clause':
      case 'named_imports':
        for (const child of node.namedChildren) if (child) walk(child)
        return
      case 'identifier':
        out.push(node.text)
        return
      case 'namespace_import':
        walk(node.namedChildren.find((c) => c?.type === 'identifier')!)
        return
      case 'import_specifier': {
        if (node.children.some((c) => c?.type === 'type')) return
        const alias = node.childForFieldName('alias') ?? node.childForFieldName('name')
        if (alias) out.push(alias.text)
        return
      }
      default:
        return
    }
  }
  if (clause) walk(clause)
  return out
}

/**
 * The names a declarator binds: one for `const x = ...`, each bound identifier
 * for `const { a, b: c, ...rest } = ...` and `const [d, , e = 1] = ...`. The
 * pattern's text is never a name (a 40-name export made a 700-character one).
 */
function boundNames(declarator: Node): string[] {
  const name = declarator.childForFieldName('name')
  if (!name) return []
  if (!PATTERNS.has(name.type)) return [name.text]
  const out: string[] = []
  const walk = (node: Node) => {
    switch (node.type) {
      case 'shorthand_property_identifier_pattern':
      case 'identifier':
        out.push(node.text)
        return
      case 'pair_pattern':
        // `{ key: target }` binds target, not key.
        walk(node.childForFieldName('value')!)
        return
      case 'assignment_pattern':
        // `{ a = 1 }` and `[b = 2]` bind the left side.
        walk(node.childForFieldName('left')!)
        return
      default:
        for (const child of node.namedChildren) if (child) walk(child)
    }
  }
  walk(name)
  return out
}

/** Statement-level blocks: the direct statements of a body, or the node itself. */
function blocksOf(node: Node): CitationBlock[] {
  const body = node.childForFieldName('body')
  const container = body?.type === 'statement_block' || body?.type === 'class_body' ? body : null
  const statements = container
    ? container.namedChildren.filter((c) => c !== null && !c.type.startsWith('comment'))
    : []
  if (statements.length === 0) return [lines(node)]
  return statements.flatMap((s) => explode(s!))
}

/**
 * A statement over the chunk budget hands over the statements inside it: the body of a
 * `try` and of its `catch`, the branches of an `if`, the body of a callback passed to
 * `new Promise`. Without this a 52-line `try` was one block, and the chunker, with no boundary to
 * split on, cut it into line windows beginning at `} catch (error) {`. Recursive, so a huge inner
 * statement explodes in turn; a statement with at most one inner statement stays whole.
 */
function explode(statement: Node): CitationBlock[] {
  if (chunkWeight(statement.text) <= MAX_CHUNK_CHARS) return [lines(statement)]
  const inner: Node[] = []
  const walk = (n: Node) => {
    if (n.type === 'statement_block') {
      for (const c of n.namedChildren) if (c && !c.type.startsWith('comment')) inner.push(c)
      return
    }
    for (const c of n.namedChildren) if (c) walk(c)
  }
  for (const c of statement.namedChildren) if (c) walk(c)
  if (inner.length <= 1) return [lines(statement)]
  return inner.flatMap((s) => explode(s))
}

/**
 * The comment run and decorators directly above a member — at most one blank line between the run
 * and the member, and none inside it ('s rule, applied to members by): its
 * `docStartLine`, and its first block. Before this a member's `@Get(':id')` and its doc comment
 * were held only by the container's line windows.
 */
function docRunAbove(siblings: Node[], index: number): CitationBlock | null {
  const member = siblings[index]
  let start = index
  while (start > 0) {
    const prev = siblings[start - 1]
    const next = siblings[start]
    if (!(prev.type.startsWith('comment') || prev.type === 'decorator')) break
    if (lines(next).startLine - lines(prev).endLine > 2) break
    start--
  }
  if (start === index) return null
  const run = {
    startLine: lines(siblings[start]).startLine,
    endLine: lines(siblings[index - 1]).endLine,
  }
  return lines(member).startLine - run.endLine <= 2 ? run : null
}

/**
 * Part of the parse derivation key: bump when the symbols or the
 * references (node_references.ts) this profile emits for the same source
 * change, or a cached parse keeps the old shape — a reads change shipped
 * without a bump and the re-index served the old references (2026-09-15).
 */
export const NODE_SYMBOLS_VERSION = 'node-symbols-24'

export function extractNodeSymbols(root: Node, source: string): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = []
  const claimed: Array<[number, number]> = []

  const visit = (
    node: Node,
    parent: string | null,
    insideFunction = false,
    doc?: CitationBlock
  ) => {
    if (node.type === 'import_statement') {
      // The names this module uses for what it imports (UAT 2026-09-15, Acode: `appSettings`
      // is an import alias in 48 files). Lines stay unclaimed: the import block is still a
      // file region, so chunks and citations are as they were.
      const specifier = node.childForFieldName('source')?.text.replace(/^['"]|['"]$/g, '') ?? null
      for (const bound of importBindings(node)) {
        const range = lines(node)
        symbols.push({
          kind: 'import',
          name: bound,
          qualifiedName: bound,
          parent: specifier,
          ...range,
          blocks: [range],
        })
      }
      return
    }
    const declaration = unwrap(node)
    const kind = DECLARATION_KINDS[declaration.type]
    if (kind) {
      const name = nameOf(declaration) ?? '<anonymous>'
      const qualifiedName = parent ? `${parent}.${name}` : name
      const range = lines(declaration)
      symbols.push({ kind, name, qualifiedName, parent, ...range, blocks: blocksOf(declaration) })
      claimed.push([range.startLine, range.endLine])
      const body = declaration.childForFieldName('body')
      const isFunctionLike = kind === 'function'
      if (body) {
        const members = body.namedChildren.filter((c): c is Node => c !== null)
        members.forEach((child, i) =>
          visit(
            child,
            qualifiedName,
            isFunctionLike || insideFunction,
            docRunAbove(members, i) ?? undefined
          )
        )
      }
      return
    }
    if (CLASS_MEMBER_KINDS.has(declaration.type) && parent) {
      const name = nameOf(declaration) ?? '<anonymous>'
      const value = declaration.childForFieldName('value')
      const isFunction =
        declaration.type !== 'public_field_definition' ||
        (value !== null && FUNCTION_VALUES.has(value.type))
      const range = lines(declaration)
      const blocks = blocksOf(isFunction && value ? value : declaration)
      symbols.push({
        kind: isFunction ? 'method' : 'variable',
        name,
        qualifiedName: `${parent}.${name}`,
        parent,
        ...range,
        blocks: doc ? [doc, ...blocks] : blocks,
        ...(doc ? { docStartLine: doc.startLine } : {}),
      })
      claimed.push([range.startLine, range.endLine])
      return
    }
    if (declaration.type === 'lexical_declaration' || declaration.type === 'variable_declaration') {
      for (const declarator of declaration.namedChildren) {
        if (declarator?.type !== 'variable_declarator') continue
        const value = declarator.childForFieldName('value')
        const isFunction = value !== null && FUNCTION_VALUES.has(value.type)
        // Locals inside a function are not symbols (owner decision, 2026-09-12); nested functions are.
        if (insideFunction && !isFunction) continue
        const range = lines(node)
        const names = boundNames(declarator)
        if (names.length === 0) names.push('<anonymous>')
        const name = names[0]
        const qualifiedName = parent ? `${parent}.${name}` : name
        symbols.push({
          kind: isFunction ? 'function' : 'variable',
          name,
          qualifiedName,
          parent,
          ...range,
          blocks: isFunction && value ? blocksOf(value) : [range],
        })
        // A pattern binds several names in one declaration; each is a variable of the same range.
        for (const bound of names.slice(1)) {
          symbols.push({
            kind: 'variable',
            name: bound,
            qualifiedName: parent ? `${parent}.${bound}` : bound,
            parent,
            ...range,
            blocks: [range],
          })
        }
        claimed.push([range.startLine, range.endLine])
        if (isFunction && value) {
          const body = value.childForFieldName('body')
          if (body)
            for (const child of body.namedChildren) if (child) visit(child, qualifiedName, true)
        }
        // A controller object: `const c = { handler: (req, res) => ..., other() {} }`. Its
        // function-valued members are methods of the variable (UAT 2026-09-14); plain values
        // are not symbols.
        if (value?.type === 'object') {
          const members = value.namedChildren.filter((c): c is Node => c !== null)
          for (const [i, member] of members.entries()) {
            let memberName: string | null = null
            let fn: Node | null = null
            if (member.type === 'pair') {
              const v = member.childForFieldName('value')
              if (v && FUNCTION_VALUES.has(v.type)) {
                memberName = member.childForFieldName('key')?.text ?? null
                fn = v
              }
            } else if (member.type === 'method_definition') {
              memberName = nameOf(member)
              fn = member
            }
            if (!memberName || !fn) continue
            const memberRange = lines(member)
            const memberDoc = docRunAbove(members, i)
            symbols.push({
              kind: 'method',
              name: memberName,
              qualifiedName: `${qualifiedName}.${memberName}`,
              parent: qualifiedName,
              ...memberRange,
              blocks: memberDoc ? [memberDoc, ...blocksOf(fn)] : blocksOf(fn),
              ...(memberDoc ? { docStartLine: memberDoc.startLine } : {}),
            })
            const body = fn.childForFieldName('body')
            if (body)
              for (const child of body.namedChildren)
                if (child) visit(child, `${qualifiedName}.${memberName}`, true)
          }
        }
      }
      return
    }
  }

  for (const child of root.namedChildren) if (child) visit(child, null)

  // A comment run immediately above a declaration documents it: it is reported as that
  // declaration's `docStartLine` and its first citation block, and its lines are claimed so it no
  // longer forms a file region. 906 of 1,041 comment-only chunks measured on a real repository
  // were doc comments orphaned from the declaration one line below them. "Immediately above"
  // allows one blank line and no more; two is a comment about something else.
  const declarations = new Map(
    symbols.filter((s) => s.kind !== 'region' && s.kind !== 'import').map((s) => [s.startLine, s])
  )
  const children = root.namedChildren.filter((c) => c !== null)
  for (let i = 0; i < children.length; i++) {
    if (!children[i]!.type.startsWith('comment')) continue
    let last = i
    while (
      last + 1 < children.length &&
      children[last + 1]!.type.startsWith('comment') &&
      lines(children[last + 1]!).startLine <= lines(children[last]!).endLine + 1
    )
      last++
    const run = {
      startLine: lines(children[i]!).startLine,
      endLine: lines(children[last]!).endLine,
    }
    const next = children[last + 1]
    const documented = next && declarations.get(lines(next).startLine)
    if (documented && lines(next!).startLine - run.endLine <= 2) {
      documented.docStartLine = run.startLine
      documented.blocks = [run, ...documented.blocks]
      claimed.push([run.startLine, run.endLine])
    }
    i = last
  }

  // Top-level statements outside every symbol form file regions, one per run.
  const covered = new Set<number>()
  for (const [start, end] of claimed) for (let line = start; line <= end; line++) covered.add(line)
  let region: { start: number; end: number; blocks: CitationBlock[] } | null = null
  let regionIndex = 0
  const flush = () => {
    if (!region) return
    regionIndex += 1
    symbols.push({
      kind: 'region',
      name: `region-${regionIndex}`,
      qualifiedName: `<file>#${regionIndex}`,
      parent: null,
      startLine: region.start,
      endLine: region.end,
      blocks: region.blocks,
    })
    region = null
  }
  for (const child of root.namedChildren) {
    if (!child) continue
    const range = lines(child)
    if (covered.has(range.startLine)) {
      flush()
      continue
    }
    if (region && range.startLine > region.end + 1) flush()
    if (!region) region = { start: range.startLine, end: range.endLine, blocks: [] }
    region.end = range.endLine
    region.blocks.push(range)
  }
  flush()

  symbols.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)
  void source
  return symbols
}

/** `export function f() {}` wraps the declaration; the export keyword is not the symbol. */
function unwrap(node: Node): Node {
  if (node.type === 'export_statement') {
    const declaration =
      node.childForFieldName('declaration') ??
      node.namedChildren.find((c) => c !== null && c.type !== 'decorator')
    if (declaration) return declaration
  }
  return node
}
