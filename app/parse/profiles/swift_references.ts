import type { Node } from 'web-tree-sitter'
import type { ParsedSymbol } from '#app/parse/profiles/node_symbols'
import type { ParsedReference } from '#app/parse/profiles/node_references'
import {
  extractMemberReferences,
  moduleResolver,
  type Dialect,
  type Resolved,
} from '#app/parse/profiles/member_references'
import { declaredTypeOf } from '#app/parse/profiles/swift_symbols'

/**
 * References from Swift: the member-language pass with Swift's
 * shapes. A Swift module has no imports between its own files, so every
 * declaration of the commit is visible everywhere; members of platform
 * types (UIKit, Foundation, the standard library) are neither references
 * nor gaps.
 */
const APPLE =
  /^(UI|NS|CG|CA|CL|AV|MK|SK|WK|CF|CN|CM|PH|SF|AR|CK|GK|HK|MP|UN|WC|OS|XC)[A-Z][A-Za-z0-9]*$/
const SWIFT_STDLIB = new Set(
  (
    'String Int Int8 Int16 Int32 Int64 UInt UInt8 UInt16 UInt32 UInt64 Double Float CGFloat Bool Character ' +
    'Array Dictionary Set Optional Function Tuple Range ClosedRange Result Task Never Void Any AnyObject Self super ' +
    'Error Equatable Hashable Comparable Codable Decodable Encodable Identifiable Sendable CaseIterable ' +
    'RawRepresentable CustomStringConvertible Sequence Collection ObservableObject Published ' +
    'Date Data URL UUID Decimal Locale Calendar TimeInterval DateFormatter NumberFormatter JSONDecoder ' +
    'JSONEncoder URLSession URLRequest Bundle FileManager DispatchQueue Timer Thread RunLoop ProcessInfo ' +
    'UserDefaults IndexPath IndexSet Notification NotificationCenter Measurement ' +
    'AnyCancellable PassthroughSubject CurrentValueSubject Just Future ' +
    'View State Binding Text VStack HStack ZStack Button Image List NavigationView NavigationStack Color Font ' +
    'Spacer EnvironmentObject ObservedObject StateObject ' +
    'print debugPrint fatalError precondition assert min max abs zip stride type class'
  ).split(' ')
)

/** Platform protocols a class may list first: a conformance, not a superclass. */
const SWIFT_PROTOCOLS = new Set(
  'ObservableObject Codable Decodable Encodable Error Equatable Hashable Comparable Identifiable Sendable CaseIterable RawRepresentable CustomStringConvertible Sequence Collection View'.split(
    ' '
  )
)

const APPLE_MODULES = new Set(
  'UIKit Foundation SwiftUI Combine XCTest CoreGraphics CoreData CoreLocation AVFoundation MapKit WebKit QuartzCore Dispatch os Darwin Swift AppKit CloudKit GameKit HealthKit MediaPlayer UserNotifications WatchKit PhotosUI Photos StoreKit Security Network'.split(
    ' '
  )
)

/** A type, function or module of the Swift standard library or an Apple framework: outside the tree. */
export const isSwiftPlatform = (name: string) =>
  APPLE.test(name) || SWIFT_STDLIB.has(name) || APPLE_MODULES.has(name)

const typeNamed = (node: Node | null | undefined): string | null =>
  node?.descendantsOfType('type_identifier')[0]?.text ?? null

const SWIFT: Dialect = {
  isPlatform: isSwiftPlatform,
  interfacesFirst: SWIFT_PROTOCOLS,
  self: 'self_expression',
  shorthand: /^\$\d+$/,
  typeDeclarations: new Set(['class_declaration', 'protocol_declaration']),
  typeInfo: (node) => {
    const name = node.childForFieldName('name')?.text ?? null
    const keyword =
      node.children.find(
        (c) => c && !c.isNamed && /^(class|struct|enum|actor|extension)$/.test(c.type)
      )?.type ?? (node.type === 'protocol_declaration' ? 'protocol' : 'class')
    return {
      name,
      keyword,
      from: keyword === 'extension' ? `extension ${name}` : name,
      body: node.childForFieldName('body'),
    }
  },
  // A class's first specifier is its superclass (the syntax cannot tell a protocol from a class);
  // `class` and `AnyObject` are constraints, not conformances.
  heritage: (node) => {
    const keyword = node.children.find(
      (c) => c && !c.isNamed && /^(class|struct|enum|actor|extension)$/.test(c.type)
    )?.type
    return node.namedChildren
      .filter((c) => c?.type === 'inheritance_specifier')
      .map((spec, i) => ({
        typeName: typeNamed(spec) ?? '',
        superclass: i === 0 && keyword === 'class',
      }))
      .filter((h) => h.typeName && h.typeName !== 'class' && h.typeName !== 'AnyObject')
  },
  constructorProperties: () => [],
  functionDeclarations: new Set(['function_declaration', 'init_declaration', 'deinit_declaration']),
  params: (fn) =>
    fn.namedChildren
      .filter((p) => p?.type === 'parameter')
      .map((p) => {
        const ids = p!.namedChildren.filter((c) => c?.type === 'simple_identifier')
        return {
          name: ids[ids.length - 1]?.text ?? '',
          type: typeNamed(
            p!.namedChildren.find(
              (c) =>
                c?.type === 'user_type' ||
                c?.type === 'optional_type' ||
                c?.type === 'type_annotation'
            )
          ),
        }
      })
      .filter((p) => p.name),
  propertyDeclaration: 'property_declaration',
  propertyName: (node) =>
    node.descendantsOfType('pattern')[0]?.descendantsOfType('simple_identifier')[0]?.text ?? null,
  declaredTypeOf,
  propertyNoVisit: new Set(['pattern', 'type_annotation', 'modifiers']),
  bindings: (node) => {
    if (node.type === 'guard_statement' || node.type === 'if_statement') {
      // `guard let view = progress as? UIView`: the bound name is a local, typed by the cast.
      const kids = node.namedChildren
      const out: Array<{ name: string; type: string | null }> = []
      kids.forEach((k, i) => {
        if (k?.type !== 'value_binding_pattern') return
        const id = kids[i + 1]?.type === 'simple_identifier' ? kids[i + 1]!.text : null
        const cast = kids[i + 2]?.type === 'as_expression' ? typeNamed(kids[i + 2]) : null
        if (id) out.push({ name: id, type: cast })
      })
      return out
    }
    if (node.type === 'for_statement') {
      const id = node.namedChildren
        .find((c) => c?.type === 'pattern')
        ?.descendantsOfType('simple_identifier')[0]?.text
      return id ? [{ name: id, type: null }] : []
    }
    return null
  },
  lambdaParams: (node) =>
    node
      .descendantsOfType('lambda_parameter')
      .map((p) => p.descendantsOfType('simple_identifier')[0]?.text ?? '')
      .filter(Boolean),
  lambdaSignature: 'lambda_function_type',
  skip: new Set(['import_declaration', 'comment', 'multiline_comment']),
  ownedHead: /^([a-z_]|super\b)/,
}

export function extractSwiftReferences(root: Node, symbols: ParsedSymbol[]): ParsedReference[] {
  return extractMemberReferences(root, symbols, SWIFT)
}

export type { Resolved }

/** The module resolver with Swift's view of the outside. */
export function swiftResolver(module: Parameters<typeof moduleResolver>[0]) {
  const resolve = moduleResolver(module)
  return (name: string, form: 'bare' | 'member'): Resolved => resolve(name, form, isSwiftPlatform)
}
