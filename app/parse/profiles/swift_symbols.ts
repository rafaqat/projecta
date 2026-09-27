import type { Node } from 'web-tree-sitter'
import type { CitationBlock, ParsedSymbol, SymbolKind } from '#app/parse/profiles/node_symbols'

/**
 * Symbol extraction for Swift (design §4 language profiles). Types, their
 * members, protocols and extensions are symbols; members declared in an
 * extension are qualified by the extended type (`Order.total`), so a type's
 * surface can be assembled across files. Conformances and attributes are
 * recorded on the symbol for the facts extractor. tree-sitter-swift uses
 * one `class_declaration` node for struct, class, enum, actor and
 * extension, distinguished by its keyword child.
 */
export interface SwiftSymbol extends ParsedSymbol {
  conformances?: string[]
  attributes?: string[]
  /** A property's declared or constructed type (`OrdersClient`, `Array` for a collection), for the link pass. */
  declaredType?: string
}

const TYPE_KEYWORDS: Record<string, SymbolKind> = {
  struct: 'struct',
  class: 'class',
  actor: 'class',
  enum: 'enum',
  extension: 'extension',
}

function lines(node: Node): CitationBlock {
  return { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }
}

function keywordOf(node: Node): string | null {
  for (const child of node.children)
    if (child && !child.isNamed && child.type in TYPE_KEYWORDS) return child.type
  return null
}

function attributesOf(node: Node): string[] {
  const modifiers = node.namedChildren.find((c) => c?.type === 'modifiers')
  return (modifiers?.namedChildren ?? [])
    .filter((c) => c?.type === 'attribute')
    .map((c) => c!.text.replace(/^@/, '').replace(/\(.*$/s, ''))
}

function conformancesOf(node: Node): string[] {
  return node.namedChildren
    .filter((c) => c?.type === 'inheritance_specifier')
    .map((c) => c!.childForFieldName('inherits_from')?.text ?? c!.text)
}

function memberName(member: Node): string | null {
  if (member.type === 'property_declaration') {
    const pattern = member.childForFieldName('name')
    return pattern?.childForFieldName('bound_identifier')?.text ?? pattern?.text ?? null
  }
  if (member.type === 'init_declaration') return 'init'
  if (member.type === 'deinit_declaration') return 'deinit'
  return member.childForFieldName('name')?.text ?? null
}

function memberKind(member: Node): SymbolKind | null {
  switch (member.type) {
    case 'property_declaration':
      return 'property'
    case 'function_declaration':
    case 'protocol_function_declaration':
    case 'init_declaration':
    case 'deinit_declaration':
    case 'subscript_declaration':
      return 'method'
    case 'protocol_property_declaration':
      return 'property'
    default:
      return null
  }
}

/**
 * The type a property declares (`client: OrdersClient`) or constructs (`= Helper()`), collections
 * and closures named by their platform kind so members of them are never gaps.
 */
export function declaredTypeOf(member: Node): string | null {
  const annotation = member.namedChildren.find((c) => c?.type === 'type_annotation')
  const named = annotation ?? member.namedChildren.find((c) => c?.type === 'call_expression')
  if (!named) return null
  const COLLECTIONS: Record<string, string> = {
    array_type: 'Array',
    dictionary_type: 'Dictionary',
    function_type: 'Function',
    tuple_type: 'Tuple',
  }
  const firstType = annotation?.descendantsOfType('type_identifier')[0]?.startIndex ?? Infinity
  for (const kind of Object.keys(COLLECTIONS)) {
    const collection = named.descendantsOfType(kind)[0]
    // The collection wraps the element type (`[Order]`), not the other way round (`Box<[Int]>`).
    if (collection && (!annotation || collection.startIndex <= firstType)) return COLLECTIONS[kind]
  }
  if (annotation) return annotation.descendantsOfType('type_identifier')[0]?.text ?? null
  const callee = named.namedChildren[0]
  return callee?.type === 'simple_identifier' && /^[A-Z]/.test(callee.text) ? callee.text : null
}

/** Statement-level blocks of a function body, or the member itself. */
function blocksOf(member: Node): CitationBlock[] {
  const body = member.childForFieldName('body')
  const statements = body?.namedChildren.find((c) => c?.type === 'statements')
  const blocks = (statements?.namedChildren ?? []).filter((c) => c && !c.type.startsWith('comment'))
  return blocks.length ? blocks.map((b) => lines(b!)) : [lines(member)]
}

export function extractSwiftSymbols(root: Node): SwiftSymbol[] {
  const symbols: SwiftSymbol[] = []

  const visitType = (node: Node, kind: SymbolKind, parent: string | null) => {
    const name = node.childForFieldName('name')?.text ?? '<anonymous>'
    // An extension's members belong to the extended type, wherever it is declared.
    const owner = kind === 'extension' ? name : parent ? `${parent}.${name}` : name
    const range = lines(node)
    symbols.push({
      kind,
      name,
      qualifiedName: kind === 'extension' ? `extension ${name}` : owner,
      parent,
      ...range,
      blocks: [range],
      conformances: conformancesOf(node),
      attributes: attributesOf(node),
    })
    const body = node.childForFieldName('body')
    for (const member of body?.namedChildren ?? []) {
      if (!member) continue
      const nested = keywordOf(member)
      if (member.type === 'class_declaration' && nested) {
        visitType(member, TYPE_KEYWORDS[nested], owner)
        continue
      }
      if (member.type === 'protocol_declaration') {
        visitType(member, 'protocol', owner)
        continue
      }
      if (member.type === 'enum_entry') {
        for (const entry of member.childrenForFieldName('name'))
          if (entry)
            symbols.push({
              kind: 'variable',
              name: entry.text,
              qualifiedName: `${owner}.${entry.text}`,
              parent: owner,
              ...lines(member),
              blocks: [lines(member)],
            })
        continue
      }
      const memberKindOf = memberKind(member)
      const memberNameOf = memberName(member)
      if (!memberKindOf || !memberNameOf) continue
      const declaredType = memberKindOf === 'property' ? declaredTypeOf(member) : null
      symbols.push({
        kind: memberKindOf,
        name: memberNameOf,
        qualifiedName: `${owner}.${memberNameOf}`,
        parent: owner,
        ...lines(member),
        blocks: blocksOf(member),
        attributes: attributesOf(member),
        ...(declaredType ? { declaredType } : {}),
      })
    }
  }

  // Imports are bindings, never chunked as declarations (the Node profile's rule): `import
  // Neumann` binds the module, so "where is Neumann imported" and the importers of a package
  // read from symbols, and the header lines before the first declaration are a region the
  // index holds (UAT 2026-09-16: Sejima's import lines were in no chunk).
  let firstDeclaration: number | null = null
  for (const child of root.namedChildren) {
    if (!child) continue
    if (child.type === 'import_declaration') {
      const module =
        child.namedChildren.find((c) => c?.type === 'identifier')?.text ??
        child.text.replace(/^import\s+/, '')
      const range = lines(child)
      symbols.push({
        kind: 'import',
        name: module,
        qualifiedName: `import ${module}`,
        parent: module,
        ...range,
        blocks: [range],
      })
      continue
    }
    if (firstDeclaration === null && !child.type.startsWith('comment'))
      firstDeclaration = child.startPosition.row + 1
  }
  if (firstDeclaration !== null && firstDeclaration > 1) {
    const range = { startLine: 1, endLine: firstDeclaration - 1 }
    symbols.push({
      kind: 'region',
      name: 'header',
      qualifiedName: '<file>#1',
      parent: null,
      ...range,
      blocks: [range],
    })
  }
  for (const child of root.namedChildren) {
    if (!child) continue
    const keyword = keywordOf(child)
    if (child.type === 'class_declaration' && keyword)
      visitType(child, TYPE_KEYWORDS[keyword], null)
    else if (child.type === 'protocol_declaration') visitType(child, 'protocol', null)
    else if (child.type === 'function_declaration') {
      const name = child.childForFieldName('name')?.text ?? '<anonymous>'
      symbols.push({
        kind: 'function',
        name,
        qualifiedName: name,
        parent: null,
        ...lines(child),
        blocks: blocksOf(child),
        attributes: attributesOf(child),
      })
    }
  }
  symbols.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)
  return symbols
}
