import type { Node } from 'web-tree-sitter'
import type { ParsedSymbol } from '#app/parse/profiles/node_symbols'
import type { ParsedReference } from '#app/parse/profiles/node_references'
import {
  extractMemberReferences,
  moduleResolver,
  type Dialect,
  type Resolved,
} from '#app/parse/profiles/member_references'
import { declaredTypeOf } from '#app/parse/profiles/kotlin_symbols'

/**
 * References from Kotlin: the member-language pass with Kotlin's
 * shapes. Imports say what is outside: a name imported from a package
 * other than the file's own module (`android.*`, `kotlin.*`, `java.*`, a
 * library) is the platform's — its members are neither references nor
 * gaps. Same-package names need no import and resolve across the module
 * in the link pass. The module is the first segments of the package
 * (`com.minar.birday`); a file without a package falls back to the
 * well-known platform prefixes.
 */
const KOTLIN_STDLIB = new Set(
  (
    'String Int Long Short Byte Double Float Boolean Char Unit Any Nothing Number CharSequence ' +
    'List MutableList Set MutableSet Map MutableMap Array ArrayList HashMap HashSet LinkedHashMap Pair Triple ' +
    'IntArray LongArray ByteArray BooleanArray Sequence Iterable Iterator Collection Comparable Comparator ' +
    'Enum Exception Throwable RuntimeException IllegalArgumentException IllegalStateException Error Result ' +
    'Regex StringBuilder Lazy Function Runnable Thread Object Class Annotation Deprecated Suppress JvmStatic ' +
    'println print listOf mutableListOf arrayListOf mapOf mutableMapOf hashMapOf setOf mutableSetOf arrayOf ' +
    'emptyList emptyMap emptySet require requireNotNull check checkNotNull error lazy run let apply also with ' +
    'TODO repeat synchronized buildString buildList maxOf minOf intArrayOf longArrayOf toString'
  ).split(' ')
)
const PLATFORM_PACKAGES =
  /^(android|androidx|kotlin|kotlinx|java|javax|dalvik|org\.jetbrains|com\.google|com\.android)(\.|$)/

/** Interfaces a class may name first in Kotlin are written as types, not constructor calls: the syntax already tells. */
const NONE = new Set<string>()

const typeNamed = (node: Node | null | undefined): string | null =>
  node?.descendantsOfType('type_identifier')[0]?.text ?? null

/** The file's view of the outside: platform names, and names imported from beyond its module. */
export function kotlinPlatformOf(symbols: ParsedSymbol[], packageName: string | null) {
  const module = packageName ? packageName.split('.').slice(0, 3).join('.') : null
  const outside = new Set<string>()
  for (const s of symbols) {
    if (s.kind !== 'import' || !s.parent) continue
    const from = s.parent
    const foreign = module
      ? !(from === module || from.startsWith(`${module}.`))
      : PLATFORM_PACKAGES.test(from)
    if (foreign) outside.add(s.name)
  }
  return (name: string) => KOTLIN_STDLIB.has(name) || outside.has(name)
}

export function packageOf(root: Node): string | null {
  return (
    root.namedChildren
      .find((c) => c?.type === 'package_header')
      ?.namedChildren.find((c) => c?.type === 'identifier')?.text ?? null
  )
}

function kotlinDialect(isPlatform: (name: string) => boolean): Dialect {
  const classKeyword = (node: Node): string => {
    const keywords = node.children.filter((c) => c && !c.isNamed).map((c) => c!.type)
    if (node.type === 'object_declaration' || node.type === 'companion_object') return 'object'
    if (keywords.includes('interface')) return 'interface'
    return 'class'
  }
  return {
    isPlatform,
    interfacesFirst: NONE,
    self: 'this_expression',
    shorthand: /^it$/,
    typeDeclarations: new Set(['class_declaration', 'object_declaration', 'companion_object']),
    typeInfo: (node) => {
      const name = node.namedChildren.find((c) => c?.type === 'type_identifier')?.text ?? null
      return {
        name,
        keyword: classKeyword(node),
        from: name,
        body:
          node.namedChildren.find(
            (c) => c?.type === 'class_body' || c?.type === 'enum_class_body'
          ) ?? null,
      }
    },
    // `: Base()` invokes the superclass constructor; `: Listener` names an interface.
    heritage: (node) =>
      node.namedChildren
        .filter((c) => c?.type === 'delegation_specifier')
        .map((spec) => ({
          typeName: typeNamed(spec) ?? '',
          superclass: spec!.namedChildren[0]?.type === 'constructor_invocation',
        }))
        .filter((h) => h.typeName),
    constructorProperties: (node) =>
      (node.namedChildren.find((c) => c?.type === 'primary_constructor')?.namedChildren ?? [])
        .filter((p) => p?.type === 'class_parameter')
        .map((p) => ({
          name: p!.namedChildren.find((c) => c?.type === 'simple_identifier')?.text ?? '',
          type: declaredTypeOf(p!),
        }))
        .filter((p) => p.name),
    functionDeclarations: new Set([
      'function_declaration',
      'secondary_constructor',
      'anonymous_initializer',
      'getter',
      'setter',
    ]),
    params: (fn) =>
      (fn.namedChildren.find((c) => c?.type === 'function_value_parameters')?.namedChildren ?? [])
        .filter((p) => p?.type === 'parameter')
        .map((p) => ({
          name: p!.namedChildren.find((c) => c?.type === 'simple_identifier')?.text ?? '',
          type: typeNamed(
            p!.namedChildren.find((c) => c?.type === 'user_type' || c?.type === 'nullable_type')
          ),
        }))
        .filter((p) => p.name),
    propertyDeclaration: 'property_declaration',
    propertyName: (node) =>
      node.namedChildren
        .find((c) => c?.type === 'variable_declaration')
        ?.namedChildren.find((c) => c?.type === 'simple_identifier')?.text ?? null,
    declaredTypeOf,
    propertyNoVisit: new Set(['variable_declaration', 'modifiers', 'binding_pattern_kind']),
    bindings: (node) => {
      if (node.type === 'for_statement') {
        const id = node.namedChildren
          .find((c) => c?.type === 'variable_declaration')
          ?.namedChildren.find((c) => c?.type === 'simple_identifier')?.text
        return id ? [{ name: id, type: null }] : []
      }
      if (node.type === 'catch_block') {
        const id = node.namedChildren.find((c) => c?.type === 'simple_identifier')?.text
        return id
          ? [{ name: id, type: typeNamed(node.namedChildren.find((c) => c?.type === 'user_type')) }]
          : []
      }
      return null
    },
    lambdaParams: (node) =>
      (node.namedChildren.find((c) => c?.type === 'lambda_parameters')?.namedChildren ?? [])
        .map((p) => p?.descendantsOfType('simple_identifier')[0]?.text ?? '')
        .filter(Boolean),
    lambdaSignature: 'lambda_parameters',
    skip: new Set([
      'import_list',
      'package_header',
      'comment',
      'line_comment',
      'multiline_comment',
    ]),
    ownedHead: /^([a-z_]|super\b)/,
    // `x!!` stands for `x`.
    unwrap: (node) => {
      let n = node
      while (n.type === 'postfix_expression' && /!!$/.test(n.text) && n.namedChildren[0])
        n = n.namedChildren[0]
      return n
    },
    opaqueReceivers: new Set(['indexing_expression', 'parenthesized_expression', 'string_literal']),
    receiverLambdas: new Set([
      'apply',
      'with',
      'run',
      'edit',
      'use',
      'buildString',
      'buildList',
      'buildMap',
      'buildSpannedString',
      'withContext',
      'transaction',
      'commit',
    ]),
    platformMembers: new Set(['entries', 'values', 'valueOf', 'Companion', 'javaClass']),
  }
}

export function extractKotlinReferences(root: Node, symbols: ParsedSymbol[]): ParsedReference[] {
  return extractMemberReferences(
    root,
    symbols,
    kotlinDialect(kotlinPlatformOf(symbols, packageOf(root)))
  )
}

export type { Resolved }

/** The module resolver with each referencing file's view of the outside. */
export function kotlinResolver(module: Parameters<typeof moduleResolver>[0]) {
  return moduleResolver(module)
}
