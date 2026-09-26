import type { Node } from 'web-tree-sitter'
import type { ParsedSymbol } from '#app/parse/profiles/node_symbols'
import type {
  ParsedReference,
  ReferenceKind,
  ReferenceTarget,
  Resolution,
} from '#app/parse/profiles/node_references'

/**
 * References for languages whose files share one namespace and whose
 * calls are members of types (Swift, Kotlin —). The
 * parser proves what it can in the file — a member of the enclosing type
 * or of a superclass declared in the file, a local bound by a constructor
 * or a cast, a typed property, parameter or lambda parameter, `super.m()`,
 * a static or companion member of a type declared in the file — and names
 * the rest from the enclosing type (`Owner.member`, `Owner.prop.member`,
 * `function`) for the link pass to resolve against the whole commit
 * (`moduleResolver`). Members of platform types are neither references nor
 * gaps. The grammar-specific shapes come from a `Dialect`.
 */
export interface Dialect {
  /** A type, function or module outside the tree (the platform, the standard library). */
  isPlatform: (name: string) => boolean
  /** Interfaces or protocols a class may list first: a conformance, not a superclass. */
  interfacesFirst: Set<string>
  /** The node type of `self`/`this`. */
  self: string
  /** A lambda's shorthand argument (`$0`, `it`). */
  shorthand: RegExp
  /** Node types that declare a type with members. */
  typeDeclarations: Set<string>
  /** A type declaration's name, its keyword (`class`, `extension`, …), how references from it are attributed, and its body. */
  typeInfo: (node: Node) => {
    name: string | null
    keyword: string
    from: string | null
    body: Node | null
  }
  /** Heritage as written: the type, and whether it is the superclass rather than an interface. */
  heritage: (node: Node) => Array<{ typeName: string; superclass: boolean }>
  /** Typed members a type declares outside its body (Kotlin's primary constructor). */
  constructorProperties: (node: Node) => Array<{ name: string; type: string | null }>
  /** Node types of functions, initialisers and the like. */
  functionDeclarations: Set<string>
  /** A function's parameters, typed when the grammar says. */
  params: (fn: Node) => Array<{ name: string; type: string | null }>
  /** The node type of a property or local declaration, and how to read it. */
  propertyDeclaration: string
  propertyName: (node: Node) => string | null
  declaredTypeOf: (node: Node) => string | null
  /** Child node types of a property declaration that are not visited (patterns, annotations). */
  propertyNoVisit: Set<string>
  /** Names a statement binds (`guard let`, `for x in`, `catch (e: T)`); null when the node binds nothing. */
  bindings: (node: Node) => Array<{ name: string; type: string | null }> | null
  /** A lambda's declared parameters, and the child holding them (not visited as code). */
  lambdaParams: (node: Node) => string[]
  lambdaSignature: string
  /** Node types never visited (imports, comments). */
  skip: Set<string>
  /** Whether a node's text names a member chain the file cannot type but the link pass can start from the enclosing type. */
  ownedHead: RegExp
  /** An expression that stands for its operand as a receiver (Kotlin's `x!!`). */
  unwrap?: (node: Node) => Node
  /** Receiver node types with no type the file gives and no name worth keeping (indexing, a call's result). */
  opaqueReceivers?: Set<string>
  /** Functions whose trailing lambda has an implicit receiver (`apply`, `with`, `edit`): bare calls inside are the receiver's. */
  receiverLambdas?: Set<string>
  /** Members every type of a kind carries from the platform (`entries`, `values` on an enum). */
  platformMembers?: Set<string>
}

type Binding =
  { kind: 'local' } | { kind: 'instance'; type: string } | { kind: 'type'; type: string }

interface Scope {
  bindings: Map<string, Binding>
  /** The type whose members `self.` and bare member calls resolve to. */
  typeName: string | null
  symbol: string
  /** A lambda with an implicit receiver: a bare call the enclosing type does not declare is the receiver's. */
  implicitReceiver?: boolean
}

export function extractMemberReferences(
  root: Node,
  symbols: ParsedSymbol[],
  dialect: Dialect
): ParsedReference[] {
  const out: ParsedReference[] = []
  const isPlatform = dialect.isPlatform
  const declared = new Set(
    symbols.filter((s) => s.kind !== 'region' && s.kind !== 'import').map((s) => s.qualifiedName)
  )
  const typeMembers = new Map<string, Set<string>>()
  const propertyTypes = new Map<string, Map<string, string>>()
  for (const s of symbols) {
    if (!s.parent || s.kind === 'region' || s.kind === 'import') continue
    const set = typeMembers.get(s.parent) ?? new Set()
    set.add(s.name)
    typeMembers.set(s.parent, set)
    const declaredType = (s as { declaredType?: string }).declaredType
    if (declaredType) {
      const props = propertyTypes.get(s.parent) ?? new Map<string, string>()
      props.set(s.name, declaredType)
      propertyTypes.set(s.parent, props)
    }
  }
  const byLine = new Map<number, ParsedSymbol[]>()
  for (const s of symbols) {
    if (s.kind === 'region' || s.kind === 'import') continue
    for (let l = s.startLine; l <= s.endLine; l++) byLine.set(l, [...(byLine.get(l) ?? []), s])
  }
  const symbolAt = (line: number): string => {
    let best: ParsedSymbol | undefined
    for (const c of byLine.get(line) ?? []) if (!best || c.startLine >= best.startLine) best = c
    return best?.qualifiedName ?? '<file>'
  }

  /** A class's superclass as written (`Child` → `Base`), platform or not. */
  const superOf = new Map<string, string>()
  /**
   * Where a member of `type` lives, walking superclasses declared in this file: the declaring
   * type, `'platform'` when the chain reaches a platform class without declaring it (the
   * member is inherited from the platform — no reference, no gap), or named from `type` itself
   * for the link pass to walk the chain across files (and to try as a free function).
   */
  const memberOwner = (
    type: string,
    member: string
  ):
    { kind: 'declared'; type: string } | { kind: 'platform' } | { kind: 'named'; type: string } => {
    let t: string | undefined = type
    const seen = new Set<string>()
    while (t && !seen.has(t)) {
      seen.add(t)
      if (isPlatform(t)) return { kind: 'platform' }
      if (typeMembers.get(t)?.has(member)) return { kind: 'declared', type: t }
      if (!declared.has(t)) break // the chain continues in another file: the link pass walks it
      t = superOf.get(t)
    }
    return { kind: 'named', type }
  }
  /** A property's declared type, walking superclasses declared in this file; `'platform'` when inherited from one. */
  const propertyType = (type: string, prop: string): string | 'platform' | undefined => {
    let t: string | undefined = type
    const seen = new Set<string>()
    while (t && !seen.has(t)) {
      seen.add(t)
      if (isPlatform(t)) return 'platform'
      const found = propertyTypes.get(t)?.get(prop)
      if (found) return found
      t = superOf.get(t)
    }
    return undefined
  }
  const memberTarget = (type: string, member: string): ReferenceTarget | 'platform' => {
    const owner = memberOwner(type, member)
    if (owner.kind === 'platform') return 'platform'
    if (owner.kind === 'declared')
      return { kind: 'symbol', qualifiedName: `${owner.type}.${member}` }
    return { kind: 'unresolved', name: `${owner.type}.${member}` }
  }

  const scopes: Scope[] = [{ bindings: new Map(), typeName: null, symbol: '<file>' }]
  const current = () => scopes[scopes.length - 1]
  const unwrap = dialect.unwrap ?? ((node: Node) => node)
  const inImplicitReceiver = () => scopes.some((sc) => sc.implicitReceiver)
  /** Set while a receiver function's arguments are visited; the lambda among them takes it. */
  let lambdaHasReceiver = false
  const lookup = (name: string): Binding | undefined => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const b = scopes[i].bindings.get(name)
      if (b) return b
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

  /** A name the file declares resolves here; a name the module may declare is left for the link pass. */
  const nameTarget = (qualified: string): ReferenceTarget =>
    declared.has(qualified)
      ? { kind: 'symbol', qualifiedName: qualified }
      : { kind: 'unresolved', name: qualified }

  /** The type of a receiver expression, one step: a local, a property of the enclosing type, a type name, `self`. */
  const receiverType = (
    node: Node
  ): { type: string; how: 'exact' | 'self' | 'type' } | 'local' | 'platform' | undefined => {
    if (node.type === dialect.self)
      return current().typeName ? { type: current().typeName!, how: 'self' } : undefined
    if (node.type === 'super_expression') {
      const sup = current().typeName ? superOf.get(current().typeName!) : undefined
      if (!sup) return undefined // an extension: the link pass walks `Owner.super.member`
      return isPlatform(sup) ? 'platform' : { type: sup, how: 'exact' }
    }
    if (node.type === 'simple_identifier') {
      if (dialect.shorthand.test(node.text)) return 'local'
      const b = lookup(node.text)
      if (b?.kind === 'local') return 'local'
      if (b?.kind === 'instance')
        return isPlatform(b.type) ? 'platform' : { type: b.type, how: 'exact' }
      if (b?.kind === 'type') return isPlatform(b.type) ? 'platform' : { type: b.type, how: 'type' }
      // A property of the enclosing type or a superclass, by its declared type; one the chain
      // does not declare before reaching a platform class is inherited from the platform.
      const owner = current().typeName
      const propType = owner ? propertyType(owner, node.text) : undefined
      if (propType && propType !== 'platform')
        return isPlatform(propType) ? 'platform' : { type: propType, how: 'exact' }
      // A capitalised name is a type (`Registry.get()`), even inside a platform subclass.
      if (/^[A-Z]/.test(node.text))
        return isPlatform(node.text) ? 'platform' : { type: node.text, how: 'type' }
      return propType === 'platform' ? 'platform' : undefined
    }
    if (node !== unwrap(node)) return receiverType(unwrap(node))
    if (dialect.opaqueReceivers?.has(node.type)) return 'local'
    if (node.type === 'navigation_expression') {
      const object = node.namedChildren[0]
      const member = node.namedChildren.find((c) => c?.type === 'navigation_suffix')
        ?.namedChildren[0]
      if (!object || !member) return undefined
      if (dialect.platformMembers?.has(member.text)) return 'platform'
      // `self.helper.configure`, `DispatchQueue.main.asyncAfter`: the object's type, then the
      // property's declared type on it — platform all the way down stays platform.
      const inner = receiverType(object)
      if (inner === 'platform' || inner === 'local') return inner
      if (!inner) return undefined
      const propType = propertyType(inner.type, member.text)
      if (propType === 'platform') return 'platform'
      if (propType) return isPlatform(propType) ? 'platform' : { type: propType, how: 'exact' }
      return undefined
    }
    return undefined
  }

  /** `event.name` → `Event.name` when the head is a typed binding of a module type; null otherwise. */
  const typedChain = (node: Node): string | null => {
    const n = unwrap(node)
    if (n.type === 'simple_identifier') {
      const b = lookup(n.text)
      return b?.kind === 'instance' && !isPlatform(b.type) ? b.type : null
    }
    if (n.type === 'navigation_expression') {
      const member = n.namedChildren.find((c) => c?.type === 'navigation_suffix')?.namedChildren[0]
      const head = n.namedChildren[0] ? typedChain(n.namedChildren[0]) : null
      return head && member ? `${head}.${member.text}` : null
    }
    return null
  }

  const call = (node: Node) => {
    const callee = node.namedChildren[0]
    if (!callee) return
    const line = node.startPosition.row + 1
    // `with(x) { … }` in Kotlin's grammar: the callee is the call `with(x)`, the lambda follows.
    if (callee.type === 'call_expression') {
      visit(callee)
      return
    }
    if (callee.type === 'simple_identifier') {
      const name = callee.text
      const b = lookup(name)
      if (b?.kind === 'local') return
      if (isPlatform(name)) return
      if (/^[A-Z]/.test(name)) {
        // A constructor: `Helper()`.
        report(line, 'new', nameTarget(name), name)
        return
      }
      // A bare call: a member of the enclosing type or its superclasses, else a module-level
      // function — or a member of a superclass declared elsewhere, named for the link pass.
      const owner = current().typeName
      const target = owner ? memberTarget(owner, name) : nameTarget(name)
      // Inside `apply { }`, `with(x) { }`, `edit { }`: a name the enclosing type does not declare
      // is the implicit receiver's, not a gap.
      if (inImplicitReceiver() && (target === 'platform' || target.kind !== 'symbol')) return
      // A bare name the in-file chain ends at a platform class without declaring may still be a
      // free function of the module: named, and the link pass decides (its text has no dot).
      report(
        line,
        'call',
        target === 'platform' ? { kind: 'unresolved', name: `${owner}.${name}` } : target,
        name
      )
      return
    }
    if (callee.type === 'navigation_expression') {
      const object = callee.namedChildren[0]
      const member = callee.namedChildren.find((c) => c?.type === 'navigation_suffix')
        ?.namedChildren[0]
      if (!object || !member) return
      const text = callee.text.replace(/\?/g, '').replace(/!!/g, '')
      // A call on a call's result (`xs.compactMap { … }.forEach`) or on an indexed value has no
      // type the file can give and no name worth keeping. The inner expression still counts.
      const receiver = unwrap(object)
      if (receiver.type === 'call_expression' || dialect.opaqueReceivers?.has(receiver.type)) {
        visit(receiver)
        return
      }
      if (
        inImplicitReceiver() &&
        receiverType(receiver) === undefined &&
        !/^[A-Z]/.test(receiver.text)
      )
        return
      const recv = receiverType(object)
      if (recv === 'local' || recv === 'platform') return
      if (!recv) {
        // A chain whose head the file can type (`event.name.isNotBlank()` with `event: Event`)
        // is named from that type, so the link pass follows the module's declared property types.
        const typed = typedChain(receiver)
        if (typed) {
          report(line, 'call', { kind: 'unresolved', name: `${typed}.${member.text}` }, text)
          return
        }
        // An unknown lower-case head is a property the file does not declare (inherited, or
        // declared in an extension elsewhere): named from the enclosing type for the link pass.
        const owner = current().typeName
        const name = owner && dialect.ownedHead.test(text) ? `${owner}.${text}` : text
        report(line, 'call', { kind: 'unresolved', name }, text)
        return
      }
      // `self.m()`, `super.m()`, `helper.m()`, `Type.m()`: the member up the receiver's chain.
      const target = memberTarget(recv.type, member.text)
      if (target === 'platform') return
      report(line, 'call', target, text)
    }
  }

  const bind = (name: string, type: string | null) =>
    current().bindings.set(name, type ? { kind: 'instance', type } : { kind: 'local' })

  const visit = (node: Node) => {
    if (dialect.skip.has(node.type)) return
    if (dialect.typeDeclarations.has(node.type)) {
      const { name, keyword, from, body } = dialect.typeInfo(node)
      const line = node.startPosition.row + 1
      const heritage = dialect.heritage(node)
      const superclass = heritage.find(
        (h) => h.superclass && !dialect.interfacesFirst.has(h.typeName)
      )
      if (name && keyword === 'class' && superclass) superOf.set(name, superclass.typeName)
      // Heritage: the superclass, then the interfaces; platform types are external.
      for (const h of heritage) {
        if (!name || !from) continue
        const kind: ReferenceKind =
          h.superclass && keyword === 'class' && !dialect.interfacesFirst.has(h.typeName)
            ? 'extends'
            : 'implements'
        if (isPlatform(h.typeName))
          out.push({
            from,
            line,
            kind,
            target: { kind: 'unresolved', name: h.typeName },
            resolution: 'external',
            targetName: h.typeName,
          })
        else
          out.push({
            from,
            line,
            kind,
            target: nameTarget(h.typeName),
            resolution: declared.has(h.typeName) ? 'exact' : 'unresolved',
            targetName: h.typeName,
          })
      }
      // Property types of this type, for receivers inside its members.
      if (name) {
        const props = propertyTypes.get(name) ?? new Map<string, string>()
        for (const p of dialect.constructorProperties(node)) if (p.type) props.set(p.name, p.type)
        for (const m of body?.namedChildren ?? []) {
          if (m?.type !== dialect.propertyDeclaration) continue
          const prop = dialect.propertyName(m)
          const type = dialect.declaredTypeOf(m)
          if (prop && type) props.set(prop, type)
        }
        propertyTypes.set(name, props)
      }
      scopes.push({ bindings: new Map(), typeName: name, symbol: name ?? current().symbol })
      // Constructor parameters that are not properties are still in scope for the body.
      for (const p of dialect.constructorProperties(node)) bind(p.name, p.type)
      for (const m of body?.namedChildren ?? []) if (m) visit(m)
      scopes.pop()
      return
    }
    if (dialect.functionDeclarations.has(node.type)) {
      scopes.push({ bindings: new Map(), typeName: current().typeName, symbol: current().symbol })
      for (const p of dialect.params(node)) bind(p.name, p.type)
      const body =
        node.childForFieldName('body') ??
        node.namedChildren.find((c) => c?.type === 'function_body')
      if (body) visit(body)
      scopes.pop()
      return
    }
    if (node.type === dialect.propertyDeclaration) {
      // `let x = Helper()` inside a body binds x; at type level the property's own types are known.
      const name = dialect.propertyName(node)
      const value = node.namedChildren.find((c) => c?.type === 'call_expression')
      const typed = dialect.declaredTypeOf(node)
      if (value) visit(value)
      if (name) bind(name, typed)
      for (const c of node.namedChildren)
        if (c && c !== value && !dialect.propertyNoVisit.has(c.type)) visit(c)
      return
    }
    const bound = dialect.bindings(node)
    if (bound) {
      for (const b of bound) bind(b.name, b.type)
      for (const c of node.namedChildren) if (c) visit(c)
      return
    }
    switch (node.type) {
      case 'call_expression': {
        call(node)
        // Arguments and lambdas inside are visited for their own references; a receiver function's
        // lambda (`apply { }`) is marked as it is entered, after the plain arguments.
        const suffix = node.namedChildren.find((c) => c?.type === 'call_suffix')
        if (!suffix) return
        let callee = node.namedChildren[0]
        while (callee?.type === 'call_expression') callee = callee.namedChildren[0]
        const calleeName =
          callee?.type === 'navigation_expression'
            ? callee.namedChildren.find((c) => c?.type === 'navigation_suffix')?.namedChildren[0]
                ?.text
            : callee?.text
        const receiverCall = Boolean(calleeName && dialect.receiverLambdas?.has(calleeName))
        for (const c of suffix.namedChildren) {
          if (!c) continue
          if (c.type === 'lambda_literal' || c.type === 'annotated_lambda')
            lambdaHasReceiver = receiverCall
          visit(c)
          lambdaHasReceiver = false
        }
        return
      }
      case 'lambda_literal': {
        scopes.push({
          bindings: new Map(),
          typeName: current().typeName,
          symbol: current().symbol,
          implicitReceiver: lambdaHasReceiver,
        })
        lambdaHasReceiver = false
        // `{ cell in … }`, `{ view -> … }`: the lambda's parameters are locals of unknown type.
        for (const id of dialect.lambdaParams(node)) bind(id, null)
        for (const c of node.namedChildren) if (c && c.type !== dialect.lambdaSignature) visit(c)
        scopes.pop()
        return
      }
      default:
        break
    }
    for (const c of node.namedChildren) if (c) visit(c)
  }
  for (const c of root.namedChildren) if (c) visit(c)
  return out
}

/** What the module resolver found: a declaration and how surely, the outside, or nothing. */
export type Resolved = { id: string; tier: 'exact' | 'heuristic' } | 'platform' | null

/**
 * The link pass's resolver for names the parser left for the module: `Type.member`
 * is looked up on `Type` and up its chain of superclasses across files; a lower-case head is a
 * property of the type whose declared type continues the walk (`self.view.addSubview` →
 * `UIView.addSubview`). The result is the one symbol id declaring it, `'platform'` when the
 * walk reaches a type outside the module without a declaration (the member is the platform's
 * or a package's — no reference, no gap), or null: nobody's, kept unresolved. Overloads share a
 * name: the first declared is taken and marked `heuristic`. A bare call (`form: 'bare'`) may
 * also be a free function. `isPlatform` is the referencing file's view of the outside.
 */
export function moduleResolver(module: {
  byQualifiedName: Map<string, string[]>
  declaredTypes: Map<string, string>
  superOf: Map<string, string>
}): (name: string, form: 'bare' | 'member', isPlatform: (name: string) => boolean) => Resolved {
  // Overloads (`set(radius:)`, `set(font:)`) share a name: the first declared, marked heuristic.
  const one = (ids: string[] | undefined): Resolved =>
    !ids?.length ? null : { id: ids[0], tier: ids.length === 1 ? 'exact' : 'heuristic' }
  return (name, form, isPlatform) => {
    /** Outside the module: a platform type, or one no file declares (a package's, like Neumann's NibView). */
    const outside = (type: string) => isPlatform(type) || !module.byQualifiedName.has(type)
    const chain = (type: string): string[] => {
      const out: string[] = []
      let t: string | undefined = type
      while (t && !out.includes(t)) {
        out.push(t)
        if (outside(t)) break
        t = module.superOf.get(t)
      }
      return out
    }
    const memberOf = (type: string, member: string): Resolved => {
      for (const t of chain(type)) {
        if (outside(t)) return 'platform'
        const found = one(module.byQualifiedName.get(`${t}.${member}`))
        if (found) return found
      }
      return null
    }
    const propertyOf = (type: string, prop: string): string | 'platform' | null => {
      for (const t of chain(type)) {
        if (outside(t)) return 'platform'
        const declared = module.declaredTypes.get(`${t}.${prop}`)
        if (declared) return declared
      }
      return null
    }
    const parts = name.split('.')
    if (parts.length === 1) {
      const found = one(module.byQualifiedName.get(name))
      // A type no file declares (`NibView`, `Package`) is a package's; a function nobody declares is a gap.
      return found ?? (/^[A-Z]/.test(name) ? 'platform' : null)
    }
    // The head is a type; every part but the last is a property whose type continues the walk.
    let type: string = parts[0]
    for (const prop of parts.slice(1, -1)) {
      // `super` walks to the superclass when the parser could not see it.
      const next = prop === 'super' ? (module.superOf.get(type) ?? null) : propertyOf(type, prop)
      if (!next) return null
      if (next === 'platform' || outside(next)) return 'platform'
      type = next
    }
    const member = parts[parts.length - 1]
    const found = memberOf(type, member)
    // A bare call the chain does not declare may be a free function of the module; failing
    // that, one the chain ends outside the module is inherited from there.
    if (form === 'bare' && (found === 'platform' || found === null))
      return one(module.byQualifiedName.get(member)) ?? found
    return found
  }
}
