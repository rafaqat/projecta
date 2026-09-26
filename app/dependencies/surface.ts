import type { Node } from 'web-tree-sitter'
import { withTree } from '#app/parse/parser'

/**
 * Exported API surface of a package's `.d.ts` files (Tier 1):
 * every exported declaration, and for `export = ns` modules the members
 * of that namespace, each with the declaration line it was read from.
 */
export interface SurfaceSymbol {
  name: string
  kind: string
  path: string
  line: number
  declaration: string
}

const KINDS: Record<string, string> = {
  function_signature: 'function',
  function_declaration: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  internal_module: 'namespace',
  module: 'namespace',
  lexical_declaration: 'variable',
  variable_declaration: 'variable',
}
const MAX_DECLARATION = 300
const PARSE_TIMEOUT_MS = 5000

function firstLine(node: Node): string {
  return node.text.split('\n')[0].trim().slice(0, MAX_DECLARATION)
}

function unwrapAmbient(node: Node): Node {
  return node.type === 'ambient_declaration' ? (node.namedChildren[0] ?? node) : node
}

function declared(node: Node, path: string, prefix = ''): SurfaceSymbol[] {
  const declaration = unwrapAmbient(node)
  const kind = KINDS[declaration.type]
  if (!kind) return []
  if (kind === 'variable') {
    return declaration.namedChildren
      .filter((d) => d?.type === 'variable_declarator')
      .map((d) => ({
        name: prefix + d!.childForFieldName('name')!.text,
        kind,
        path,
        line: d!.startPosition.row + 1,
        declaration: firstLine(declaration),
      }))
  }
  const name = declaration.childForFieldName('name')?.text
  if (!name) return []
  return [
    {
      name: prefix + name,
      kind,
      path,
      line: declaration.startPosition.row + 1,
      declaration: firstLine(declaration),
    },
  ]
}

export async function extractSurface(files: Map<string, string>): Promise<SurfaceSymbol[]> {
  const out: SurfaceSymbol[] = []
  for (const [path, content] of files) {
    if (!path.endsWith('.d.ts')) continue
    await withTree({ path, content, timeoutMs: PARSE_TIMEOUT_MS }, (root) => {
      const ambient = new Map<string, Node>()
      const exportedNames = new Set<string>()
      for (const statement of root.namedChildren) {
        if (!statement) continue
        if (statement.type === 'export_statement') {
          const declaration = statement.childForFieldName('declaration')
          if (declaration) {
            out.push(...declared(declaration, path))
            continue
          }
          // `export = e` and `export default e` re-export an ambient declaration by name.
          const target = statement.namedChildren.find((c) => c?.type === 'identifier')
          if (target) exportedNames.add(target.text)
          for (const spec of statement.descendantsOfType('export_specifier'))
            exportedNames.add(spec!.childForFieldName('name')!.text)
        } else if (statement.type === 'ambient_declaration') {
          const inner = unwrapAmbient(statement)
          const name = inner.childForFieldName('name')?.text
          if (name) ambient.set(`${inner.type}:${name}`, statement)
        }
      }
      for (const [key, statement] of ambient) {
        const name = key.split(':')[1]
        if (!exportedNames.has(name)) continue
        const inner = unwrapAmbient(statement)
        if (inner.type === 'internal_module' || inner.type === 'module') {
          out.push({
            name,
            kind: 'namespace',
            path,
            line: inner.startPosition.row + 1,
            declaration: firstLine(inner),
          })
          for (const member of inner.childForFieldName('body')?.namedChildren ?? [])
            if (member) out.push(...declared(member, path, `${name}.`))
        } else out.push(...declared(statement, path))
      }
    })
  }
  return out
}
