import type { Node } from 'web-tree-sitter'
import type { ParsedSymbol } from '#app/parse/profiles/node_symbols'
import {
  callbackParameterTypes,
  knowsModule,
  PLATFORM_CALLS,
  PLATFORM_NEW,
  PLATFORM_OBJECTS,
  returnTypeOf,
  typeOfAnnotation,
  typeOfImportCall,
  type ExternalType,
} from '#app/parse/profiles/node_receivers'

/**
 * References resolved from the syntax tree: where a symbol of
 * this file is called, constructed or read, from which symbol, and the same
 * for names bound by import. A scope stack of declarations — parameters,
 * locals, functions, classes, imports — resolves every identifier to its
 * innermost declaration; a local resolves too, so it is never mistaken for
 * a symbol, and is not reported. Receivers resolve one step: `this.m()` to
 * the enclosing class's member, `x.m()` to `X.m` when `x` was bound by
 * `new X()`, and `imp.m()` to the imported module's member. Nothing is
 * inferred across files here; the indexer joins import targets to the
 * modules' symbols once every file is parsed.
 */
export type ReferenceKind =
  'call' | 'new' | 'reference' | 'extends' | 'implements' | 'route_handler' | 'middleware'

/**
 * How sure the parser is: `exact` follows a declaration, a type annotation, a
 * constructor or an import binding; `heuristic` matched a member name against the one class in
 * scope that declares it — a guess the reader sees badged; `unresolved` is a call the file
 * cannot place, kept by name and counted, never taken for absence; `external` names a platform or
 * package the parser can already tell is outside the tree (a Swift `UIView` superclass).
 */
export type Resolution = 'exact' | 'heuristic' | 'unresolved' | 'external'

export type ReferenceTarget =
  | { kind: 'symbol'; qualifiedName: string }
  | {
      kind: 'import'
      module: string
      name: string
      member?: string
      /**
       * `member` is called on what the imported function returns (`const app = createApp();
       * app.listen()`): the link pass reads the declaring file's return types.
       */
      viaReturn?: boolean
    }
  | { kind: 'unresolved'; name: string }

export interface ParsedReference {
  /** The symbol whose body holds the reference; `<file>` at the top level outside any symbol. */
  from: string
  line: number
  kind: ReferenceKind
  target: ReferenceTarget
  resolution: Resolution
  /** The reference as written (`this.gateway.charge`, `POST /orders/:id/refund`). */
  targetName: string
}

type Binding =
  | { kind: 'local'; param?: boolean }
  | { kind: 'symbol'; qualifiedName: string; className?: string }
  | { kind: 'import'; module: string; name: string }
  /** A local (or symbol) whose value is `new X()`: member calls resolve through X. */
  | { kind: 'instance'; of: Binding }
  /**
   * A value of a type outside the tree the receiver table names: `express()`,
   * `req: Request`. `symbol` names the module-level declaration holding it, when there is one
   * (`const app = express()`): a read of `app` is still a reference to that declaration.
   */
  | { kind: 'external'; module: string; type: string; param?: boolean; symbol?: string }
  /** A module binding whose value the file cannot type (`const schema = z.object(...)`): its members are unresolved chains. */
  | { kind: 'opaque'; symbol?: string }
  /** The value a call on a symbol or an imported function returned: typed by that declaration's return, if known. */
  | { kind: 'returned'; of: ReferenceTarget; symbol?: string }

interface Scope {
  bindings: Map<string, Binding>
  /** The class whose members `this.` resolves to, inside a method. */
  className: string | null
  /** The enclosing symbol for `from`. */
  symbol: string
}

const FUNCTION_LIKE = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'generator_function',
])
const BLOCK_LIKE = new Set(['statement_block', 'for_statement', 'for_in_statement', 'catch_clause'])

/** Facts the extractor learns beside the references: what each function returns, when it is an external type. */
export interface NodeFacts {
  returnTypes: Map<string, ExternalType>
}

export function extractNodeReferences(
  root: Node,
  symbols: ParsedSymbol[],
  facts: NodeFacts = { returnTypes: new Map() }
): ParsedReference[] {
  const out: ParsedReference[] = []
  /** Top-level declarations of the file by name: a module binding used as a receiver is read. */
  const moduleSymbolNames = new Set(
    symbols
      .filter((s) => !s.parent && s.kind !== 'region' && s.kind !== 'import')
      .map((s) => s.name)
  )
  const byLine = new Map<number, ParsedSymbol[]>()
  for (const s of symbols) {
    if (s.kind === 'region' || s.kind === 'import') continue
    for (let l = s.startLine; l <= s.endLine; l++) {
      const list = byLine.get(l) ?? []
      list.push(s)
      byLine.set(l, list)
    }
  }
  /** The innermost declared symbol containing a line: the `from` of a reference. */
  const symbolAt = (line: number): string => {
    const candidates = byLine.get(line) ?? []
    let best: ParsedSymbol | undefined
    for (const c of candidates) if (!best || c.startLine >= best.startLine) best = c
    return best?.qualifiedName ?? '<file>'
  }
  const classMembers = new Map<string, Set<string>>()
  for (const s of symbols)
    if (s.parent && (s.kind === 'method' || s.kind === 'property')) {
      const set = classMembers.get(s.parent) ?? new Set()
      set.add(s.name)
      classMembers.set(s.parent, set)
    }
  /** What a class's properties are bound to: `private refunds: RefundService`, `mailer = new Mailer()`. */
  const propertyBindings = new Map<string, Map<string, Binding>>()

  // Module scope: every top-level symbol and import binding of the file.
  const moduleScope: Scope = { bindings: new Map(), className: null, symbol: '<file>' }
  for (const s of symbols) {
    if (s.kind === 'region') continue
    if (s.kind === 'import' && s.parent)
      moduleScope.bindings.set(s.name, {
        kind: 'import',
        module: s.parent,
        name: importedName(root, s.name),
      })
    else if (!s.parent)
      moduleScope.bindings.set(s.name, {
        kind: 'symbol',
        qualifiedName: s.qualifiedName,
        className: s.kind === 'class' ? s.qualifiedName : undefined,
      })
  }
  /** Module bindings whose value constructs a class or resolves through an import (`const inventory = new InventoryService()`). */
  const moduleInstances = new Map<string, Binding>()
  const scopes: Scope[] = [moduleScope]
  const lookup = (name: string): Binding | undefined => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const b = scopes[i].bindings.get(name)
      if (b) return b
    }
    return undefined
  }
  const current = () => scopes[scopes.length - 1]
  const declare = (name: string, binding: Binding) => current().bindings.set(name, binding)
  /** `import type { Request } from 'express'` binds nothing at runtime; a parameter typed with it is that type. */
  const typeImports = typeOnlyImports(root)
  /** Callback parameters typed by position from the registration they are passed to (R1). */
  const callbackTypes = new WeakMap<Node, ExternalType[]>()
  const external = (t: ExternalType, param = false): Binding => ({
    kind: 'external',
    module: t.module,
    type: t.type,
    param,
  })

  /** What a value expression binds to, one step: `new X()` → instance of X's binding; `x` → x's binding. */
  const valueBinding = (value: Node | null): Binding | undefined => {
    if (!value) return undefined
    // CommonJS: `const x = require('./m')` binds the module, as `import * as x` would.
    const required = requiredModule(value)
    if (required) return { kind: 'import', module: required, name: '*' }
    if (value.type === 'new_expression') {
      const ctor = value.childForFieldName('constructor')
      const target = ctor?.type === 'identifier' ? lookup(ctor.text) : undefined
      return target && target.kind !== 'local' ? { kind: 'instance', of: target } : undefined
    }
    if (value.type === 'await_expression') return valueBinding(value.namedChildren[0] ?? null)
    // `express()`, `Router()`: what a call on an import yields, by the receiver table.
    if (value.type === 'call_expression') {
      const fn = value.childForFieldName('function')
      const target = fn ? resolveExpression(fn) : undefined
      if (target?.kind === 'import') {
        const t = typeOfImportCall(target.module, target.name, target.member)
        if (t) return external(t)
        // `const app = createApp()`: typed by what createApp returns, which the link pass knows.
        return target.member ? { kind: 'opaque' } : { kind: 'returned', of: target }
      }
      if (target?.kind === 'symbol') return { kind: 'returned', of: target }
      return undefined
    }
    return undefined
  }

  const report = (
    line: number,
    kind: ReferenceKind,
    target: ReferenceTarget,
    targetName: string,
    resolution: Resolution = target.kind === 'unresolved' ? 'unresolved' : 'exact'
  ) => out.push({ from: symbolAt(line), line, kind, target, resolution, targetName })

  /** The one class in scope (declared or imported) whose members include `member`: a guess, badged heuristic. */
  const classByMember = (member: string): ReferenceTarget | undefined => {
    const candidates: ReferenceTarget[] = []
    for (const [cls, members] of classMembers)
      if (members.has(member))
        candidates.push({ kind: 'symbol', qualifiedName: `${cls}.${member}` })
    for (const [name, b] of moduleScope.bindings)
      if (b.kind === 'import' && /^[A-Z]/.test(name))
        candidates.push({ kind: 'import', module: b.module, name: b.name, member })
    // One declared class with the member is the guess; with none declared, one imported class
    // (the link pass checks the member exists there). Several candidates: no guess.
    const declared = candidates.filter((c) => c.kind === 'symbol')
    if (declared.length === 1) return declared[0]
    if (declared.length === 0 && candidates.length === 1) return candidates[0]
    return undefined
  }
  /** Platform APIs a bare or member call reaches: not references of the repository, never counted. */
  const PLATFORM_ROOTS = new Set([
    'console',
    'JSON',
    'Math',
    'Object',
    'Array',
    'Promise',
    'Number',
    'String',
    'Date',
    'Error',
    'process',
    'Buffer',
    'Symbol',
    'Reflect',
    'Map',
    'Set',
    'RegExp',
    'setTimeout',
    'setInterval',
    'clearTimeout',
    'clearInterval',
    'require',
    'parseInt',
    'parseFloat',
    'Boolean',
    'BigInt',
    'globalThis',
    'window',
    'document',
    'fetch',
    'structuredClone',
    'queueMicrotask',
    'super',
  ])

  /** The reference target of a callee/receiver expression, if it resolves to a symbol or an import. */
  const resolveExpression = (node: Node): ReferenceTarget | undefined => {
    if (node.type === 'identifier') {
      const b = lookup(node.text)
      return targetOf(b)
    }
    if (node.type === 'member_expression') {
      const object = node.childForFieldName('object')
      const property = node.childForFieldName('property')
      if (!object || !property) return undefined
      const member = property.text
      if (object.type === 'this') {
        const cls = current().className
        return cls && classMembers.get(cls)?.has(member)
          ? { kind: 'symbol', qualifiedName: `${cls}.${member}` }
          : undefined
      }
      // `this.refunds.refundPayment()`: the property's binding (a type annotation, a `new`, a
      // parameter property) names the class; without one, the one class declaring the member.
      if (object.type === 'member_expression') {
        const inner = object.childForFieldName('object')
        const prop = object.childForFieldName('property')
        const cls = current().className
        if (inner?.type === 'this' && prop && cls) {
          const bound = propertyBindings.get(cls)?.get(prop.text)
          const target = bound ? memberOf(bound, member) : undefined
          if (target) return target
          return undefined
        }
      }
      if (object.type === 'identifier') {
        const b = lookup(object.text)
        return memberOf(b, member)
      }
      // `res.status(401).json()`: a call whose result the receiver table types.
      if (object.type === 'call_expression') {
        const returned = externalResultOf(object)
        return returned ? memberOf(external(returned), member) : undefined
      }
      // `new X().m()` and deeper chains: one step through the receiver.
      const inner = resolveExpression(object)
      if (inner?.kind === 'import')
        return { ...inner, member: inner.member ? `${inner.member}.${member}` : member }
      if (inner?.kind === 'symbol')
        return { kind: 'symbol', qualifiedName: `${inner.qualifiedName}.${member}` }
      return undefined
    }
    if (node.type === 'new_expression') {
      const ctor = node.childForFieldName('constructor')
      return ctor ? resolveExpression(ctor) : undefined
    }
    return undefined
  }
  /** What an external type a call expression yields, by the table: the callee's receiver type and member. */
  const externalResultOf = (call: Node): ExternalType | undefined => {
    const fn = call.childForFieldName('function')
    if (fn?.type !== 'member_expression') return undefined
    const object = fn.childForFieldName('object')
    const member = fn.childForFieldName('property')?.text
    if (!object || !member) return undefined
    const receiver =
      object.type === 'identifier'
        ? externalOf(lookup(object.text))
        : object.type === 'call_expression'
          ? externalResultOf(object)
          : undefined
    return receiver ? returnTypeOf(receiver, member) : undefined
  }
  /** The external type a binding carries: an `external` binding, or an instance of an import the table knows. */
  const externalOf = (b: Binding | undefined): ExternalType | undefined => {
    if (!b) return undefined
    if (b.kind === 'external') return { module: b.module, type: b.type }
    // An instance of an imported class is external only when the table knows the package
    // (`import { Request } from 'express'`); `new InventoryService()` from './services' is not.
    if (b.kind === 'instance' && b.of.kind === 'import' && knowsModule(b.of.module))
      return { module: b.of.module, type: b.of.name }
    if (b.kind === 'returned' && b.of.kind === 'symbol')
      return facts.returnTypes.get(b.of.qualifiedName)
    return undefined
  }
  const targetOf = (b: Binding | undefined): ReferenceTarget | undefined => {
    if (!b || b.kind === 'local') return undefined
    if (b.kind === 'external' || b.kind === 'opaque' || b.kind === 'returned')
      return b.symbol ? { kind: 'symbol', qualifiedName: b.symbol } : undefined
    if (b.kind === 'symbol') return { kind: 'symbol', qualifiedName: b.qualifiedName }
    if (b.kind === 'import') return { kind: 'import', module: b.module, name: b.name }
    return targetOf(b.of)
  }
  const memberOf = (b: Binding | undefined, member: string): ReferenceTarget | undefined => {
    if (!b || b.kind === 'local' || b.kind === 'opaque') return undefined
    if (b.kind === 'external') return { kind: 'import', module: b.module, name: b.type, member }
    if (b.kind === 'returned') {
      // A member of what a function returned: known here for a function of this file whose
      // return type the pass has seen; left to the link pass for an imported one.
      const known = externalOf(b)
      if (known) return memberOf(external(known), member)
      if (b.of.kind === 'import') return { ...b.of, member, viaReturn: true }
      return undefined
    }
    if (b.kind === 'instance') return memberOf(b.of, member)
    if (b.kind === 'import') return { kind: 'import', module: b.module, name: b.name, member }
    // A member on a class or an object-literal variable of this file.
    if (classMembers.get(b.qualifiedName)?.has(member))
      return { kind: 'symbol', qualifiedName: `${b.qualifiedName}.${member}` }
    // A module binding holding an instance (`const inventory = new InventoryService()`).
    const held = b.kind === 'symbol' ? moduleInstances.get(b.qualifiedName) : undefined
    return held ? memberOf(held, member) : undefined
  }

  /** Interfaces and type aliases declared in the file: heritage targets that are not classes. */
  const interfaces = new Set(
    symbols
      .filter((sym) => sym.kind === 'interface' || sym.kind === 'type')
      .map((sym) => sym.qualifiedName)
  )
  /** `: RefundService` names a class in scope: an instance binding through the type. */
  const bindingOfType = (typed: Node | null): Binding | undefined => {
    if (!typed) return undefined
    const named =
      typed.namedChildren.find((c) => c?.type === 'type_identifier') ?? typed.namedChildren[0]
    if (!named) return undefined
    const b = lookup(named.text)
    if (b && b.kind !== 'local') return { kind: 'instance', of: b }
    // `req: Request` from `import type { Request } from 'express'`, `sku: string`.
    const typeImport = typeImports.get(named.text)
    if (typeImport) return external({ module: typeImport, type: named.text })
    const platform = typeOfAnnotation(named.text)
    return platform ? external(platform) : undefined
  }
  /** Why a callee did not resolve: a local's or platform's member (not a reference), a guessable member, or unknown. */
  const unresolvedCall = (fn: Node): 'local' | 'platform' | 'heuristic' | 'unresolved' => {
    if (fn.type === 'identifier') {
      const b = lookup(fn.text)
      // A call of a parameter is kept by name (R6): `next()`, `operation()`.
      if ((b?.kind === 'local' || b?.kind === 'external') && b.param) return 'unresolved'
      if (b?.kind === 'local' || b?.kind === 'external') return 'local'
      if (PLATFORM_ROOTS.has(fn.text)) return 'platform'
      return 'unresolved'
    }
    if (fn.type !== 'member_expression') return 'local'
    let receiver: Node | null = fn
    while (receiver && receiver.type === 'member_expression')
      receiver = receiver.childForFieldName('object')
    if (!receiver) return 'local'
    // `z.number().int()`, `db.get().collection()`: a chain on a call's result is kept as written
    // (R7) when the chain is rooted at an import or a declaration of the file; rooted at a
    // local or a parameter (`res.status(404).json()` with `res` untyped) it is that value's API,
    // dropped as before.
    if (receiver.type === 'call_expression') {
      let chainRoot: Node | null = receiver
      while (
        chainRoot &&
        (chainRoot.type === 'call_expression' || chainRoot.type === 'member_expression')
      )
        chainRoot = chainRoot.childForFieldName(
          chainRoot.type === 'call_expression' ? 'function' : 'object'
        )
      if (chainRoot?.type === 'identifier') {
        const b = lookup(chainRoot.text)
        if (b?.kind === 'local' || (b?.kind === 'external' && b.param)) return 'local'
        if (b?.kind === 'external') return 'local'
      }
      return 'unresolved'
    }
    if (receiver.type === 'this') {
      const object = fn.childForFieldName('object')
      // `this.x.m()` with x an untyped property: a guess by member name; `this.m()` with no
      // member m: unknown.
      return object?.type === 'member_expression' ? 'heuristic' : 'unresolved'
    }
    if (receiver.type === 'identifier') {
      const b = lookup(receiver.text)
      if (b?.kind === 'local' || b?.kind === 'external') return 'local'
      if (b?.kind === 'opaque' || b?.kind === 'returned') return 'unresolved'
      if (PLATFORM_ROOTS.has(receiver.text)) return 'platform'
      // A variable of this file holding a value the parser did not follow (`const router =
      // Router()`): its members are that value's API, not references of the repository.
      if (b?.kind === 'symbol' && !b.className) return 'local'
      if (b) return 'heuristic'
      return 'unresolved'
    }
    return 'local'
  }
  /**
   * `router.post('/x', mw, handler)`, `app.use(mw)`: the handlers are entry points of the
   * repository, edges from the file region to each handler that resolves.
   */
  const routeBindings = (call: Node, fn: Node, args: Node | null) => {
    if (fn.type !== 'member_expression' || !args) return
    const verb = fn.childForFieldName('property')?.text ?? ''
    if (!/^(get|post|put|patch|delete|options|head|all|use)$/.test(verb)) return
    const receiver = fn.childForFieldName('object')?.text ?? ''
    if (!/(router|app|server|route)/i.test(receiver)) return
    const list = args.namedChildren.filter((a): a is Node => Boolean(a))
    const first = list[0]
    const hasPath = first?.type === 'string' || first?.type === 'template_string'
    const path = hasPath ? first.text.replace(/^['"`]|['"`]$/g, '') : null
    const handlers = hasPath ? list.slice(1) : list
    const line = call.startPosition.row + 1
    handlers.forEach((h, i) => {
      const last = i === handlers.length - 1
      const kind: ReferenceKind = verb === 'use' || !last ? 'middleware' : 'route_handler'
      const target = resolveExpression(
        h.type === 'member_expression' && /\.prototype\./.test(h.text) ? prototypeMember(h) : h
      )
      const label = path
        ? `${verb === 'use' ? 'USE' : verb.toUpperCase()} ${path}`
        : `USE ${h.text}`
      if (target)
        out.push({
          from: symbolAt(line),
          line,
          kind,
          target,
          resolution: 'exact',
          targetName: label,
        })
      else if (
        kind === 'route_handler' &&
        (h.type === 'arrow_function' || h.type === 'function_expression')
      )
        // An inline handler: the route is still an entry of this file, recorded by its label.
        out.push({
          from: symbolAt(line),
          line,
          kind,
          target: { kind: 'unresolved', name: `${label} (inline)` },
          resolution: 'exact',
          targetName: label,
        })
    })
  }
  /** `OrdersController.prototype.refund` names the method `OrdersController.refund`. */
  const prototypeMember = (node: Node): Node => {
    const property = node.childForFieldName('property')
    const object = node.childForFieldName('object')
    const cls = object?.childForFieldName('object')
    if (!property || !cls) return node
    return {
      ...node,
      type: 'member_expression',
      text: `${cls.text}.${property.text}`,
      childForFieldName: (f: string) => (f === 'object' ? cls : f === 'property' ? property : null),
    } as unknown as Node
  }

  /** A bare or member platform call the table records: `Number(x)`, `setTimeout(f)`, `console.log(x)`. */
  const platformCall = (fn: Node): ReferenceTarget | undefined => {
    if (fn.type === 'identifier') {
      const t = PLATFORM_CALLS[fn.text]
      return t ? { kind: 'import', module: t.module, name: t.type } : undefined
    }
    if (fn.type === 'member_expression') {
      const object = fn.childForFieldName('object')
      const property = fn.childForFieldName('property')
      if (object?.type !== 'identifier' || !property || lookup(object.text)) return undefined
      const module = PLATFORM_OBJECTS[object.text]
      return module ? { kind: 'import', module, name: property.text } : undefined
    }
    return undefined
  }
  /** The declared thing a member call's receiver reads (R4, R5), or nothing. */
  const receiverRead = (object: Node | null): ReferenceTarget | undefined => {
    if (!object) return undefined
    if (object.type === 'member_expression') {
      // `this.pool.query()`, `this.stripe.paymentIntents.create()`: the field at the root is read.
      let n: Node | null = object
      while (n && n.type === 'member_expression' && n.childForFieldName('object')?.type !== 'this')
        n = n.childForFieldName('object')
      const prop =
        n?.type === 'member_expression' ? n.childForFieldName('property')?.text : undefined
      const cls = current().className
      if (prop && cls && propertyBindings.get(cls)?.has(prop))
        return { kind: 'symbol', qualifiedName: `${cls}.${prop}` }
      return undefined
    }
    // A module binding used as the receiver is read, whatever it holds: `inventory.reserve()`,
    // `ordersRouter.post()`, `app.listen()`.
    if (object.type === 'identifier' && moduleSymbolNames.has(object.text) && scopes.length >= 1) {
      const b = lookup(object.text)
      if (b && b.kind !== 'local') return { kind: 'symbol', qualifiedName: object.text }
    }
    return undefined
  }
  const declareParams = (fn: Node) => {
    const params = fn.childForFieldName('parameters') ?? fn.childForFieldName('parameter')
    if (!params) return
    const positional = callbackTypes.get(fn)
    let position = 0
    const walk = (n: Node) => {
      if (n.type === 'identifier' || n.type === 'shorthand_property_identifier_pattern') {
        declare(n.text, { kind: 'local', param: true })
        return
      }
      // `req: Request`, `sku: string`: a typed parameter carries its type; an untyped one passed
      // to a registration is typed by its position (R1).
      if (n.type === 'required_parameter' || n.type === 'optional_parameter') {
        const pattern = n.childForFieldName('pattern')
        const typed = bindingOfType(n.childForFieldName('type'))
        const byPosition = positional?.[position]
        position++
        if (pattern?.type === 'identifier') {
          const binding = typed ?? (byPosition ? external(byPosition, true) : undefined)
          const asParam: Binding = !binding
            ? { kind: 'local', param: true }
            : binding.kind === 'local' || binding.kind === 'external'
              ? { ...binding, param: true }
              : binding
          declare(pattern.text, asParam)
          return
        }
      }
      for (const c of n.namedChildren) if (c && c.type !== 'type_annotation') walk(c)
    }
    if (params.type === 'identifier') {
      const byPosition = positional?.[0]
      declare(params.text, byPosition ? external(byPosition, true) : { kind: 'local', param: true })
    } else walk(params)
  }

  const visit = (node: Node) => {
    switch (node.type) {
      case 'import_statement':
      case 'property_identifier':
      case 'type_annotation':
      case 'type_arguments':
      case 'comment':
        return
      case 'lexical_declaration':
      case 'variable_declaration': {
        for (const d of node.namedChildren) {
          if (d?.type !== 'variable_declarator') continue
          const name = d.childForFieldName('name')
          const value = d.childForFieldName('value')
          if (value) visit(value)
          if (!name) continue
          const inModule = scopes.length === 1
          const names: string[] = []
          const collect = (n: Node) => {
            if (n.type === 'identifier' || n.type === 'shorthand_property_identifier_pattern')
              names.push(n.text)
            else for (const c of n.namedChildren) if (c) collect(c)
          }
          collect(name)
          const required = requiredModule(value)
          for (const bound of names) {
            // `const { pick } = require('./picker')` imports `pick`; `const m = require('./m')` the module.
            const instance =
              required && name.type === 'object_pattern'
                ? ({ kind: 'import', module: required, name: bound } as Binding)
                : valueBinding(value)
            if (instance) {
              // A module-level declaration keeps its identity whatever it holds: a read of
              // `app`, `router` or `limiter` is a reference to it (as before).
              const named =
                inModule &&
                moduleSymbolNames.has(bound) &&
                (instance.kind === 'external' ||
                  instance.kind === 'opaque' ||
                  instance.kind === 'returned')
                  ? { ...instance, symbol: bound }
                  : instance
              declare(bound, named)
              // `const inventory = new InventoryService()` at module level: reads of `inventory`
              // are references to that binding (R5).
              if (inModule && instance.kind === 'instance' && instance.of.kind === 'symbol')
                moduleInstances.set(bound, instance)
            } else if (!inModule) declare(bound, { kind: 'local' })
          }
        }
        return
      }
      case 'call_expression': {
        const fn = node.childForFieldName('function')
        const args = node.childForFieldName('arguments')
        if (fn) {
          const line = fn.startPosition.row + 1
          const target = resolveExpression(fn)
          const receiver = fn.type === 'member_expression' ? fn.childForFieldName('object') : null
          // The external type the call is made on, when the table knows it: a typed or positional
          // parameter (`res`), a chained call's result (`res.status(401)`), a typed field.
          const receiverType =
            receiver?.type === 'identifier'
              ? externalOf(lookup(receiver.text))
              : receiver?.type === 'call_expression'
                ? externalResultOf(receiver)
                : undefined
          if (target) report(line, 'call', target, fn.text, receiverType ? 'external' : undefined)
          else {
            // Not proven: a member of an untyped `this.x` matches the one class declaring it
            // (heuristic); an unknown callee is kept by name (unresolved); a local's or a
            // platform's member is neither — unless the receiver table names it (R2).
            const guess = unresolvedCall(fn)
            const platform = guess === 'platform' ? platformCall(fn) : undefined
            if (platform) report(line, 'call', platform, fn.text, 'external')
            else if (guess === 'heuristic' || guess === 'unresolved') {
              const member =
                fn.type === 'member_expression' ? fn.childForFieldName('property')?.text : undefined
              const byName = guess === 'heuristic' && member ? classByMember(member) : undefined
              if (byName) report(line, 'call', byName, fn.text, 'heuristic')
              else
                report(line, 'call', { kind: 'unresolved', name: fn.text }, fn.text, 'unresolved')
            }
            // What it reads still counts (`KINDS.has(x)` reads KINDS), and a receiver that is
            // itself an expression is visited for its own references.
            visit(fn)
          }
          if (target && fn.type === 'member_expression') {
            const object = fn.childForFieldName('object')
            if (object && object.type !== 'identifier' && object.type !== 'this') visit(object)
            // R4, R5: the field or module binding the call goes through is read too —
            // `this.pool` in `this.pool.query()`, `inventory` in `inventory.reserve()` when it
            // holds an instance of a class of the module.
            const read = receiverRead(object)
            if (read) report(line, 'reference', read, object?.text ?? '')
          }
          // A callback passed to a route or middleware registration on an Express receiver has
          // its parameters typed by position (R1).
          if (receiverType && fn.type === 'member_expression' && args) {
            const member = fn.childForFieldName('property')?.text ?? ''
            const types = callbackParameterTypes(receiverType, member)
            if (types)
              for (const a of args.namedChildren)
                if (a && FUNCTION_LIKE.has(a.type)) callbackTypes.set(a, types)
          }
          routeBindings(node, fn, args)
        }
        if (args) visit(args)
        return
      }
      case 'identifier':
      case 'shorthand_property_identifier': {
        // A bare read of a symbol or an import: `fail(KINDS)`, `module.exports = { KINDS }`.
        const target = targetOf(lookup(node.text))
        if (target) report(node.startPosition.row + 1, 'reference', target, node.text)
        return
      }
      case 'member_expression': {
        // `KINDS.has` outside a call, or a member the file cannot resolve: the object is read.
        // A property read on an external value (`req.params.id`, `app.locals.x`) is not an edge
        // (: only calls and constructions on external types are) — but a module-level
        // declaration at the root (`app`) is still read.
        const rootBinding = lookup(rootIdentifier(node)?.text ?? '')
        if (externalOf(rootBinding)) {
          const declaration = targetOf(rootBinding)
          if (declaration) report(node.startPosition.row + 1, 'reference', declaration, node.text)
          return
        }
        const target = resolveExpression(node)
        if (target) report(node.startPosition.row + 1, 'reference', target, node.text)
        else {
          const object = node.childForFieldName('object')
          if (object) visit(object)
        }
        return
      }
      case 'return_statement': {
        // `return app` where `app` is an Application: the enclosing function returns that type
        //; the link pass hands it to files that call the function.
        const value = node.namedChildren[0]
        if (value?.type === 'identifier') {
          const t = externalOf(lookup(value.text))
          if (t) facts.returnTypes.set(symbolAt(node.startPosition.row + 1), t)
        }
        if (value) visit(value)
        return
      }
      case 'new_expression': {
        // Standalone `new X()` (not a declarator's value, handled above).
        const ctor = node.childForFieldName('constructor')
        const target = ctor ? resolveExpression(ctor) : undefined
        if (target) report(node.startPosition.row + 1, 'new', target, ctor?.text ?? '')
        else if (ctor?.type === 'identifier' && !lookup(ctor.text) && PLATFORM_NEW[ctor.text]) {
          // `new Promise`, `new Error`: platform constructions by module (R3).
          const t = PLATFORM_NEW[ctor.text]
          report(
            node.startPosition.row + 1,
            'new',
            { kind: 'import', module: t.module, name: t.type },
            ctor.text,
            'external'
          )
        }
        const args = node.childForFieldName('arguments')
        if (args) visit(args)
        return
      }
      case 'class_declaration':
      case 'abstract_class_declaration':
      case 'class': {
        const name = node.childForFieldName('name')?.text ?? null
        const body = node.childForFieldName('body')
        const line = node.startPosition.row + 1
        // Heritage: `extends B`, `implements C` are edges from the class to what it builds on.
        for (const clause of node.namedChildren) {
          if (clause?.type !== 'class_heritage') continue
          for (const part of clause.namedChildren) {
            if (!part) continue
            const kind: ReferenceKind = part.type === 'implements_clause' ? 'implements' : 'extends'
            const names =
              part.type === 'extends_clause' || part.type === 'implements_clause'
                ? part.namedChildren.filter(
                    (n) =>
                      n &&
                      (n.type === 'identifier' ||
                        n.type === 'type_identifier' ||
                        n.type === 'member_expression')
                  )
                : [part]
            for (const n of names) {
              if (!n) continue
              const target =
                targetOf(lookup(n.text.split('.')[0])) ??
                (n.type === 'type_identifier' ? undefined : undefined)
              const resolved =
                target ??
                (interfaces.has(n.text)
                  ? { kind: 'symbol' as const, qualifiedName: n.text }
                  : undefined)
              if (resolved)
                out.push({
                  from: name ?? symbolAt(line),
                  line,
                  kind,
                  target: resolved,
                  resolution: 'exact',
                  targetName: n.text,
                })
              else
                out.push({
                  from: name ?? symbolAt(line),
                  line,
                  kind,
                  target: { kind: 'unresolved', name: n.text },
                  resolution: 'unresolved',
                  targetName: n.text,
                })
            }
          }
        }
        if (name) {
          const props = new Map<string, Binding>()
          if (body)
            for (const m of body.namedChildren) {
              if (!m) continue
              if (m.type === 'public_field_definition' || m.type === 'field_definition') {
                const prop = m.childForFieldName('name')?.text
                const typed = m.childForFieldName('type')
                const value = m.childForFieldName('value')
                const b = bindingOfType(typed) ?? valueBinding(value)
                if (prop && b) props.set(prop, b)
              }
              // `constructor(private readonly refunds: RefundService)`: a parameter property.
              if (
                m.type === 'method_definition' &&
                m.childForFieldName('name')?.text === 'constructor'
              ) {
                const params = m.childForFieldName('parameters')
                for (const param of params?.namedChildren ?? []) {
                  if (!param) continue
                  const hasModifier =
                    param.namedChildren.some((c) => c?.type === 'accessibility_modifier') ||
                    /^(public|private|protected|readonly)\b/.test(param.text)
                  if (!hasModifier) continue
                  const pattern = param.childForFieldName('pattern')
                  const typed = param.childForFieldName('type')
                  const b = bindingOfType(typed)
                  if (pattern?.type === 'identifier' && b) props.set(pattern.text, b)
                }
              }
            }
          propertyBindings.set(name, props)
        }
        scopes.push({ bindings: new Map(), className: name, symbol: name ?? current().symbol })
        if (body) for (const m of body.namedChildren) if (m) visit(m)
        scopes.pop()
        return
      }
      default:
        break
    }
    if (FUNCTION_LIKE.has(node.type)) {
      scopes.push({ bindings: new Map(), className: current().className, symbol: current().symbol })
      declareParams(node)
      const body = node.childForFieldName('body')
      if (body) visit(body)
      scopes.pop()
      return
    }
    if (BLOCK_LIKE.has(node.type)) {
      scopes.push({ bindings: new Map(), className: current().className, symbol: current().symbol })
      for (const c of node.namedChildren) if (c) visit(c)
      scopes.pop()
      return
    }
    for (const c of node.namedChildren) if (c) visit(c)
  }

  // Hoisting: function declarations and classes are visible before their line; declared above.
  for (const c of root.namedChildren) if (c) visit(c)
  return out
}

/** The identifier at the root of a member chain (`req` in `req.params.id`), or null. */
function rootIdentifier(node: Node): Node | null {
  let n: Node | null = node
  while (n && n.type === 'member_expression') n = n.childForFieldName('object')
  return n && n.type === 'identifier' ? n : null
}

/** The module a `require('...')` call names, or null. */
function requiredModule(value: Node | null): string | null {
  if (value?.type !== 'call_expression') return null
  const fn = value.childForFieldName('function')
  const args = value.childForFieldName('arguments')
  const first = args?.namedChildren[0]
  if (fn?.type !== 'identifier' || fn.text !== 'require' || first?.type !== 'string') return null
  return first.text.replace(/^['"`]|['"`]$/g, '')
}

/** The symbol a module exports as default (`export default X`, `export default class X`, …), if any. */
export function defaultExportOf(root: Node): string | null {
  for (const statement of root.namedChildren) {
    if (statement?.type !== 'export_statement') continue
    if (!statement.children.some((c) => c?.type === 'default')) continue
    const value = statement.childForFieldName('value') ?? statement.childForFieldName('declaration')
    if (!value) continue
    if (value.type === 'identifier') return value.text
    const name = value.childForFieldName('name')
    if (name) return name.text
  }
  return null
}

/** The name an import binding stands for in its module: `default`, `*`, or the imported name behind an alias. */
function importedName(root: Node, local: string): string {
  for (const statement of root.namedChildren) {
    if (statement?.type !== 'import_statement') continue
    const clause = statement.namedChildren.find((c) => c?.type === 'import_clause')
    if (!clause) continue
    for (const c of clause.namedChildren) {
      if (!c) continue
      if (c.type === 'identifier' && c.text === local) return 'default'
      if (c.type === 'namespace_import') {
        const id = c.namedChildren.find((n) => n?.type === 'identifier')
        if (id?.text === local) return '*'
      }
      if (c.type === 'named_imports')
        for (const spec of c.namedChildren) {
          if (spec?.type !== 'import_specifier') continue
          const name = spec.childForFieldName('name')?.text
          const alias = spec.childForFieldName('alias')?.text
          if ((alias ?? name) === local && name) return name
        }
    }
  }
  return local
}

/** `import type { Request, Response } from 'express'`: the names and their module. */
function typeOnlyImports(root: Node): Map<string, string> {
  const out = new Map<string, string>()
  for (const statement of root.namedChildren) {
    if (statement?.type !== 'import_statement') continue
    const clause = statement.namedChildren.find((c) => c?.type === 'import_clause')
    const typeOnly = [...statement.children, ...(clause?.children ?? [])].some(
      (c) => c?.type === 'type'
    )
    if (!typeOnly || !clause) continue
    const module = statement.childForFieldName('source')?.text.replace(/^['"`]|['"`]$/g, '') ?? ''
    for (const c of clause.namedChildren) {
      if (c?.type !== 'named_imports') continue
      for (const spec of c.namedChildren) {
        if (spec?.type !== 'import_specifier') continue
        const name = spec.childForFieldName('name')?.text
        const alias = spec.childForFieldName('alias')?.text
        if (name) out.set(alias ?? name, module)
      }
    }
  }
  return out
}
