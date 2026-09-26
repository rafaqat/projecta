import type { Node } from 'web-tree-sitter'
import type { CitationBlock, ParsedSymbol, SymbolKind } from '#app/parse/profiles/node_symbols'

/**
 * Symbol extraction for Kotlin (design §4 language profiles).
 * tree-sitter-kotlin uses one `class_declaration` for class, interface,
 * enum, data and sealed classes (the keyword and modifiers tell them
 * apart), `object_declaration` for objects and `companion_object` inside
 * a class body. A companion's members are reached as `Class.member`, so
 * they belong to the enclosing class. Primary-constructor `val`/`var`
 * parameters are properties. Imports are bindings (never chunked as
 * declarations): `import a.b.C` binds `C` from package `a.b`.
 */
export interface KotlinSymbol extends ParsedSymbol {
  /** Superclass and interfaces as written, for the facts extractor. */
  supertypes?: string[]
  annotations?: string[]
  /** A property's declared or constructed type, for the link pass. */
  declaredType?: string
}

function lines(node: Node): CitationBlock {
  return { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }
}

/** `class`, `interface` or `enum` from the declaration's keyword tokens. */
function classKind(node: Node): SymbolKind {
  const keywords = node.children.filter((c) => c && !c.isNamed).map((c) => c!.type)
  if (keywords.includes('interface')) return 'interface'
  if (keywords.includes('enum') || node.childForFieldName('body')?.type === 'enum_class_body')
    return 'enum'
  const modifiers = node.namedChildren.find((c) => c?.type === 'modifiers')
  if (modifiers?.namedChildren.some((c) => c?.type === 'class_modifier' && c.text === 'enum'))
    return 'enum'
  return 'class'
}

function annotationsOf(node: Node): string[] {
  const modifiers = node.namedChildren.find((c) => c?.type === 'modifiers')
  return (modifiers?.namedChildren ?? [])
    .filter((c) => c?.type === 'annotation')
    .map((c) => c!.text.replace(/^@/, '').replace(/\(.*$/s, ''))
}

function supertypesOf(node: Node): string[] {
  return node.namedChildren
    .filter((c) => c?.type === 'delegation_specifier')
    .map((c) => c!.descendantsOfType('type_identifier')[0]?.text ?? c!.text)
}

/**
 * The type a property declares (`binding: ActivityMainBinding`) or constructs
 * (`= Helper()`); a function type is `Function`.
 */
export function declaredTypeOf(node: Node): string | null {
  const declaration =
    node.type === 'variable_declaration' || node.type === 'class_parameter'
      ? node
      : node.namedChildren.find((c) => c?.type === 'variable_declaration')
  const annotation = declaration?.namedChildren.find(
    (c) => c?.type === 'user_type' || c?.type === 'nullable_type' || c?.type === 'function_type'
  )
  if (annotation) {
    if (annotation.type === 'function_type') return 'Function'
    // `List<Event>` names the collection, not the element: the outermost identifier.
    return annotation.descendantsOfType('type_identifier')[0]?.text ?? null
  }
  const value = node.namedChildren.find((c) => c?.type === 'call_expression')
  const callee = value?.namedChildren[0]
  return callee?.type === 'simple_identifier' && /^[A-Z]/.test(callee.text) ? callee.text : null
}

/** A compound statement longer than this is cited by the statements nested inside it. */
const LONG_STATEMENT_LINES = 8

/** The nearest `statements` lists under a node (a try body, a catch body, an if branch, a lambda). */
function nestedStatementLists(node: Node): Node[] {
  const out: Node[] = []
  const stack = [...node.namedChildren].reverse()
  while (stack.length) {
    const n = stack.pop()
    if (!n) continue
    if (n.type === 'statements') out.push(n)
    else stack.push(...[...n.namedChildren].reverse())
  }
  return out
}

/**
 * Statement-level blocks: each statement of a list, and a long compound statement (`try`,
 * `if`, `for`, `when`, a lambda) replaced by the blocks of the statements nested inside it,
 * recursively — so no citation block is a whole 100-line `try` the provider cites into by line
 * (birday UAT 2026-09-16, EventWorker.doWork; INV-13 renders nothing for such a citation).
 */
function statementBlocks(list: Node): CitationBlock[] {
  return list.namedChildren
    .filter((c): c is Node => Boolean(c) && !c!.type.includes('comment'))
    .flatMap((statement) => {
      const range = lines(statement)
      if (range.endLine - range.startLine + 1 <= LONG_STATEMENT_LINES) return [range]
      const nested = nestedStatementLists(statement)
      return nested.length ? nested.flatMap(statementBlocks) : [range]
    })
}

/** Statement-level blocks of a function body, or the member itself. */
function blocksOf(member: Node): CitationBlock[] {
  const body = member.namedChildren.find((c) => c?.type === 'function_body')
  const statements = body?.namedChildren.find((c) => c?.type === 'statements')
  const blocks = statements ? statementBlocks(statements) : []
  return blocks.length ? blocks : [lines(member)]
}

export function extractKotlinSymbols(root: Node): KotlinSymbol[] {
  const symbols: KotlinSymbol[] = []

  const property = (node: Node, owner: string, name: string) => {
    const declaredType = declaredTypeOf(node)
    symbols.push({
      kind: 'property',
      name,
      qualifiedName: `${owner}.${name}`,
      parent: owner,
      ...lines(node),
      blocks: [lines(node)],
      annotations: annotationsOf(node),
      ...(declaredType ? { declaredType } : {}),
    })
  }

  const method = (node: Node, owner: string | null) => {
    const name = node.namedChildren.find((c) => c?.type === 'simple_identifier')?.text
    if (!name) return
    // An extension function (`fun String.shout()`) is qualified by its receiver.
    const receiver = node.namedChildren.find(
      (c) =>
        c?.type === 'user_type' &&
        c.startIndex <
          (node.namedChildren.find((k) => k?.type === 'simple_identifier')?.startIndex ?? 0)
    )
    const receiverName = receiver?.descendantsOfType('type_identifier')[0]?.text ?? null
    const qualifiedOwner = owner ?? receiverName
    symbols.push({
      kind: owner ? 'method' : 'function',
      name,
      qualifiedName: qualifiedOwner ? `${qualifiedOwner}.${name}` : name,
      parent: owner ?? receiverName,
      ...lines(node),
      blocks: blocksOf(node),
      annotations: annotationsOf(node),
    })
  }

  const members = (body: Node | null | undefined, owner: string) => {
    for (const member of body?.namedChildren ?? []) {
      if (!member) continue
      switch (member.type) {
        case 'class_declaration':
          visitType(member, owner)
          break
        case 'object_declaration':
          visitType(member, owner)
          break
        case 'companion_object':
          // Reached as `Class.member`: the companion's members belong to the class.
          members(
            member.namedChildren.find((c) => c?.type === 'class_body'),
            owner
          )
          break
        case 'property_declaration': {
          const name = member.namedChildren
            .find((c) => c?.type === 'variable_declaration')
            ?.namedChildren.find((c) => c?.type === 'simple_identifier')?.text
          if (name) property(member, owner, name)
          break
        }
        case 'function_declaration':
          method(member, owner)
          break
        case 'enum_entry': {
          const name = member.namedChildren.find((c) => c?.type === 'simple_identifier')?.text
          if (name)
            symbols.push({
              kind: 'variable',
              name,
              qualifiedName: `${owner}.${name}`,
              parent: owner,
              ...lines(member),
              blocks: [lines(member)],
            })
          break
        }
        default:
          break
      }
    }
  }

  const visitType = (node: Node, parent: string | null) => {
    const name =
      node.namedChildren.find((c) => c?.type === 'type_identifier')?.text ?? '<anonymous>'
    const owner = parent ? `${parent}.${name}` : name
    const range = lines(node)
    const type: KotlinSymbol = {
      kind: node.type === 'object_declaration' ? 'class' : classKind(node),
      name,
      qualifiedName: owner,
      parent,
      ...range,
      blocks: [range],
      supertypes: supertypesOf(node),
      annotations: annotationsOf(node),
    }
    symbols.push(type)
    const before = symbols.length
    // Primary-constructor `val`/`var` parameters are properties of the class.
    const constructor = node.namedChildren.find((c) => c?.type === 'primary_constructor')
    for (const p of constructor?.namedChildren ?? []) {
      if (p?.type !== 'class_parameter') continue
      if (!p.namedChildren.some((c) => c?.type === 'binding_pattern_kind')) continue
      const pname = p.namedChildren.find((c) => c?.type === 'simple_identifier')?.text
      if (pname) property(p, owner, pname)
    }
    members(
      node.namedChildren.find((c) => c?.type === 'class_body' || c?.type === 'enum_class_body'),
      owner
    )
    // A type's citation blocks are its direct members' blocks in order — statement-level inside
    // methods — so a chunk of a large class is never one block the provider cites into by line
    // (birday UAT 2026-09-16: EventWorker, 262 lines, sent as 38-line single blocks).
    const memberBlocks = symbols
      .slice(before)
      .filter((m) => m.parent === owner)
      .flatMap((m) => m.blocks)
      .sort((a, b) => a.startLine - b.startLine)
    if (memberBlocks.length) type.blocks = memberBlocks
  }

  let firstDeclaration: number | null = null
  const packageName =
    root.namedChildren
      .find((c) => c?.type === 'package_header')
      ?.namedChildren.find((c) => c?.type === 'identifier')?.text ?? null
  for (const child of root.namedChildren) {
    if (!child) continue
    if (child.type === 'import_list') {
      for (const header of child.namedChildren) {
        if (header?.type !== 'import_header') continue
        const path = header.namedChildren.find((c) => c?.type === 'identifier')?.text
        if (!path) continue
        const segments = path.split('.')
        const range = lines(header)
        symbols.push({
          kind: 'import',
          name: segments[segments.length - 1],
          qualifiedName: `import ${path}`,
          parent: segments.slice(0, -1).join('.'),
          ...range,
          blocks: [range],
        })
      }
      continue
    }
    if (child.type === 'package_header') continue
    if (firstDeclaration === null && !child.type.startsWith('comment'))
      firstDeclaration = child.startPosition.row + 1
  }
  if (firstDeclaration !== null && firstDeclaration > 1) {
    const range = { startLine: 1, endLine: firstDeclaration - 1 }
    // The header region (package and imports) carries the package as its parent: the link pass
    // reads the file's module from it.
    symbols.push({
      kind: 'region',
      name: 'header',
      qualifiedName: '<file>#1',
      parent: packageName,
      ...range,
      blocks: [range],
    })
  }
  for (const child of root.namedChildren) {
    if (!child) continue
    if (child.type === 'class_declaration' || child.type === 'object_declaration')
      visitType(child, null)
    else if (child.type === 'function_declaration') method(child, null)
    else if (child.type === 'property_declaration') {
      const name = child.namedChildren
        .find((c) => c?.type === 'variable_declaration')
        ?.namedChildren.find((c) => c?.type === 'simple_identifier')?.text
      if (name) {
        const declaredType = declaredTypeOf(child)
        symbols.push({
          kind: 'variable',
          name,
          qualifiedName: name,
          parent: null,
          ...lines(child),
          blocks: [lines(child)],
          ...(declaredType ? { declaredType } : {}),
        })
      }
    }
  }
  symbols.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)
  return symbols
}

/**
 * A Gradle Kotlin DSL script: a manifest, not a program. Each top-level statement
 * (`plugins { }`, `android { }`, `dependencies { }`, an assignment) is a region named by its
 * callee, and each statement inside its block is a citation block, so one dependency line or
 * one build type is one citable block.
 */
export function extractGradleScriptRegions(root: Node): KotlinSymbol[] {
  const symbols: KotlinSymbol[] = []
  for (const statement of root.namedChildren) {
    if (!statement || statement.type.includes('comment')) continue
    let callee = statement.namedChildren[0]
    while (callee?.type === 'call_expression') callee = callee.namedChildren[0]
    const name =
      statement.type === 'call_expression' && callee
        ? callee.text.split(/[.(]/)[0]
        : `<file>#${statement.startPosition.row + 1}`
    const lambda = statement.descendantsOfType('lambda_literal')[0]
    const inner = lambda?.namedChildren.find((c) => c?.type === 'statements')
    const blocks = (inner?.namedChildren ?? [])
      .filter((c) => c && !c.type.includes('comment'))
      .map((c) => lines(c!))
    symbols.push({
      kind: 'region',
      name,
      qualifiedName: `<file>#${name}`,
      parent: null,
      ...lines(statement),
      blocks: blocks.length ? blocks : [lines(statement)],
    })
  }
  return symbols
}
