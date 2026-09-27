import type { Node } from 'web-tree-sitter'
import { withTree } from '#app/parse/parser'

/**
 * Endpoint extractor for the Node profile (design §4): Express mount
 * prefixes composed across files, NestJS controllers with the global
 * prefix, and Next.js file-system routes (Pages and App Router). Output is
 * a fact table, never model text: each row carries the file and
 * line it was read from so the `EndpointTable` view can cite it.
 */
export interface Endpoint {
  method: string
  path: string
  framework: 'express' | 'nestjs' | 'nextjs' | 'adonis'
  file: string
  line: number
  handler: string | null
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'])
const NEST_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All'])
/** AdonisJS verbs on the router service; `any` is its wildcard. */
const ADONIS_METHODS = new Set([...HTTP_METHODS, 'any'])
const ADONIS_ROUTER = '@adonisjs/core/services/router'
const PARSE_TIMEOUT_MS = 5000

const isFunctionNode = (node: Node | null) =>
  node?.type === 'arrow_function' ||
  node?.type === 'function_expression' ||
  node?.type === 'function_declaration' ||
  node?.type === 'generator_function_declaration'

interface RouteDecl {
  receiver: string
  method: string
  path: string
  line: number
  handler: string | null
}
interface MountDecl {
  receiver: string
  prefix: string
  target: string
  line: number
}
interface FileRoutes {
  apps: Set<string>
  routers: Set<string>
  /** Local name → the module it comes from and the name exported there (`default` for a default import). */
  imports: Map<string, { source: string; name: string }>
  /** Exported name (`default` included) → the local name it refers to. */
  exports: Map<string, string>
  /** Functions by local name (`default` for an anonymous default export) → their first parameter. */
  functions: Map<string, string>
  routes: RouteDecl[]
  mounts: MountDecl[]
  /** Calls that hand an app or router to a function: `routes(app)`. */
  passes: Array<{ callee: string; arg: string; line: number }>
}

const joinPath = (...parts: string[]) =>
  '/' +
  parts
    .flatMap((p) => p.split('/'))
    .filter(Boolean)
    .join('/')

const stringArg = (node: Node | null): string | null =>
  node?.type === 'string' || node?.type === 'template_string' ? node.text.slice(1, -1) : null

/** Every call expression, walked iteratively; nesting past the cap is ignored rather than recursed (hostile input). */
const MAX_DEPTH = 200
function* calls(root: Node): Generator<Node> {
  const stack: Array<[Node, number]> = [[root, 0]]
  while (stack.length) {
    const [node, depth] = stack.pop()!
    if (node.type === 'call_expression') yield node
    if (depth >= MAX_DEPTH) continue
    for (const child of node.namedChildren) if (child) stack.push([child, depth + 1])
  }
}

/** Express: what each file declares on which receiver. */
function expressFile(root: Node): FileRoutes {
  const file: FileRoutes = {
    apps: new Set(),
    routers: new Set(),
    imports: new Map(),
    exports: new Map(),
    functions: new Map(),
    routes: [],
    mounts: [],
    passes: [],
  }
  // The first parameter's name: `(app)` in JavaScript, `(app: Express)` in TypeScript, `app =>`.
  const firstParam = (fn: Node | null): string | null => {
    const params = fn?.childForFieldName('parameters') ?? fn?.childForFieldName('parameter')
    let first = params?.type === 'identifier' ? params : (params?.namedChildren[0] ?? null)
    if (first?.type === 'required_parameter' || first?.type === 'optional_parameter')
      first = first.childForFieldName('pattern') ?? first.namedChildren[0] ?? null
    return first?.type === 'identifier' ? first.text : null
  }
  const isFunction = (node: Node | null) =>
    node?.type === 'arrow_function' ||
    node?.type === 'function_expression' ||
    node?.type === 'function_declaration' ||
    node?.type === 'generator_function_declaration'
  for (const statement of root.namedChildren) {
    if (statement?.type === 'import_statement') {
      const source = stringArg(statement.childForFieldName('source'))
      const clause = statement.namedChildren.find((c) => c?.type === 'import_clause')
      if (!source || !clause) continue
      for (const spec of clause.descendantsOfType('import_specifier'))
        file.imports.set(
          (spec!.childForFieldName('alias') ?? spec!.childForFieldName('name'))!.text,
          { source, name: spec!.childForFieldName('name')!.text }
        )
      const defaultImport = clause.namedChildren.find((c) => c?.type === 'identifier')
      if (defaultImport) file.imports.set(defaultImport.text, { source, name: 'default' })
    } else if (statement?.type === 'export_statement') {
      const declaration = statement.childForFieldName('declaration')
      const value = statement.childForFieldName('value')
      const isDefault = statement.children.some((c) => c?.type === 'default')
      if (
        declaration?.type === 'lexical_declaration' ||
        declaration?.type === 'variable_declaration'
      ) {
        for (const d of declaration.namedChildren)
          if (d?.type === 'variable_declarator') {
            const name = d.childForFieldName('name')?.text
            if (name) file.exports.set(name, name)
          }
      } else if (declaration && isFunction(declaration)) {
        const name = declaration.childForFieldName('name')?.text ?? 'default'
        file.exports.set(isDefault ? 'default' : name, name)
        const param = firstParam(declaration)
        if (param) file.functions.set(name, param)
      } else if (value?.type === 'identifier') {
        file.exports.set('default', value.text)
      } else if (value && isFunction(value)) {
        file.exports.set('default', 'default')
        const param = firstParam(value)
        if (param) file.functions.set('default', param)
      }
      for (const spec of statement.descendantsOfType('export_specifier'))
        file.exports.set(
          (spec!.childForFieldName('alias') ?? spec!.childForFieldName('name'))!.text,
          spec!.childForFieldName('name')!.text
        )
    }
  }
  for (const fn of root.descendantsOfType([
    'function_declaration',
    'generator_function_declaration',
  ])) {
    const name = fn!.childForFieldName('name')?.text
    const param = firstParam(fn)
    if (name && param) file.functions.set(name, param)
  }
  for (const declarator of root.descendantsOfType('variable_declarator')) {
    const name = declarator!.childForFieldName('name')?.text
    const value = declarator!.childForFieldName('value')
    if (!name) continue
    if (isFunction(value)) {
      const param = firstParam(value)
      if (param) file.functions.set(name, param)
      continue
    }
    if (value?.type !== 'call_expression') continue
    const callee = value.childForFieldName('function')!.text
    if (callee === 'express') file.apps.add(name)
    else if (callee === 'Router' || callee === 'express.Router') file.routers.add(name)
  }
  for (const call of calls(root)) {
    const fn = call.childForFieldName('function')
    const args = call.childForFieldName('arguments')!.namedChildren.filter((a) => a !== null)
    const line = call.startPosition.row + 1
    if (fn?.type === 'identifier') {
      if (args.length === 1 && args[0].type === 'identifier')
        file.passes.push({ callee: fn.text, arg: args[0].text, line })
      continue
    }
    if (fn?.type !== 'member_expression') continue
    let receiver = fn.childForFieldName('object')!.text
    const property = fn.childForFieldName('property')!.text
    // `router.route(path).get(a).post(b)`: the verb calls chain off a `.route(path)` call, on
    // the receiver of that call; each verb is one route on the same path.
    const chained = routeChain(fn.childForFieldName('object')!)
    if (chained && HTTP_METHODS.has(property)) {
      const handler = args[args.length - 1]
      file.routes.push({
        receiver: chained.receiver,
        method: property.toUpperCase(),
        path: chained.path,
        line,
        handler: handler?.type === 'identifier' ? handler.text : null,
      })
      continue
    }
    receiver = fn.childForFieldName('object')!.text
    if (property === 'use') {
      const prefix = stringArg(args[0]) ?? '/'
      const target = args[args.length - 1]
      if (target?.type === 'identifier')
        file.mounts.push({ receiver, prefix, target: target.text, line })
    } else if (HTTP_METHODS.has(property) && stringArg(args[0]) !== null) {
      const handler = args[args.length - 1]
      file.routes.push({
        receiver,
        method: property.toUpperCase(),
        path: stringArg(args[0])!,
        line,
        handler: handler?.type === 'identifier' ? handler.text : null,
      })
    }
  }
  return file
}

/**
 * Walks a member chain down to a `.route(path)` call and returns its receiver and
 * path, or null when the chain does not start with one.
 */
function routeChain(node: Node): { receiver: string; path: string } | null {
  let current: Node | null = node
  for (let i = 0; i < 16 && current; i++) {
    if (current.type !== 'call_expression') return null
    const fn: Node | null = current.childForFieldName('function')
    if (fn?.type !== 'member_expression') return null
    const property = fn.childForFieldName('property')!.text
    const object: Node = fn.childForFieldName('object')!
    if (property === 'route') {
      const args = current.childForFieldName('arguments')!.namedChildren.filter((a) => a !== null)
      const path = stringArg(args[0] ?? null)
      return path === null ? null : { receiver: object.text, path }
    }
    if (!HTTP_METHODS.has(property)) return null
    current = object
  }
  return null
}

/** Resolves a relative import to an indexed file path (`./routes/orders.js` → `src/routes/orders.ts`). */
function resolveImport(from: string, source: string, paths: Set<string>): string | null {
  if (!source.startsWith('.')) return null
  const base = from.split('/').slice(0, -1)
  for (const segment of source.split('/')) {
    if (segment === '..') base.pop()
    else if (segment !== '.') base.push(segment)
  }
  const stem = base.join('/').replace(/\.(js|mjs|cjs|jsx)$/, '')
  for (const candidate of [
    stem,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.js`,
    `${stem}/index.ts`,
    `${stem}/index.js`,
  ])
    if (paths.has(candidate)) return candidate
  return null
}

function composeExpress(files: Map<string, FileRoutes>): Endpoint[] {
  const out: Endpoint[] = []
  const paths = new Set(files.keys())
  const seen = new Set<string>()
  const walk = (file: string, receiver: string, prefix: string, depth: number) => {
    const decl = files.get(file)
    const key = `${file}\u0000${receiver}\u0000${prefix}`
    if (!decl || depth > 8 || seen.has(key)) return
    seen.add(key)
    for (const route of decl.routes)
      if (route.receiver === receiver)
        out.push({
          method: route.method,
          path: joinPath(prefix, route.path),
          framework: 'express',
          file,
          line: route.line,
          handler: route.handler,
        })
    for (const mount of decl.mounts) {
      if (mount.receiver !== receiver) continue
      const imported = decl.imports.get(mount.target)
      const targetFile = imported ? resolveImport(file, imported.source, paths) : file
      if (!targetFile) continue
      if (targetFile === file) {
        if (decl.routers.has(mount.target))
          walk(file, mount.target, joinPath(prefix, mount.prefix), depth + 1)
        continue
      }
      // The router's name inside its own module: what the module exports under the imported name.
      const local = files.get(targetFile)?.exports.get(imported!.name) ?? mount.target
      walk(targetFile, local, joinPath(prefix, mount.prefix), depth + 1)
    }
    // `routes(app)`: the function mounts on its parameter, in this file or an imported one.
    for (const pass of decl.passes) {
      if (pass.arg !== receiver) continue
      const imported = decl.imports.get(pass.callee)
      const targetFile = imported ? resolveImport(file, imported.source, paths) : file
      if (!targetFile) continue
      const target = files.get(targetFile)
      const local = imported ? (target?.exports.get(imported.name) ?? imported.name) : pass.callee
      const param = target?.functions.get(local)
      if (param) walk(targetFile, param, prefix, depth + 1)
    }
  }
  for (const [file, decl] of files) for (const app of decl.apps) walk(file, app, '/', 0)
  return out
}

/** NestJS: `@Controller(prefix)` classes with method decorators, under `setGlobalPrefix`. */
function nestFile(
  root: Node,
  file: string
): { endpoints: Endpoint[]; globalPrefix: string | null } {
  const endpoints: Endpoint[] = []
  let globalPrefix: string | null = null
  for (const call of calls(root)) {
    const fn = call.childForFieldName('function')
    if (
      fn?.type === 'member_expression' &&
      fn.childForFieldName('property')!.text === 'setGlobalPrefix'
    )
      globalPrefix = stringArg(call.childForFieldName('arguments')!.namedChildren[0] ?? null) ?? ''
  }
  const decoratorCall = (decorator: Node) =>
    decorator.namedChildren[0]?.type === 'call_expression' ? decorator.namedChildren[0] : null
  for (const klass of root.descendantsOfType('class_declaration')) {
    const holder = klass!.parent?.type === 'export_statement' ? klass!.parent : klass!
    const controller = holder.namedChildren
      .filter((c) => c?.type === 'decorator')
      .map((d) => decoratorCall(d!))
      .find((c) => c?.childForFieldName('function')?.text === 'Controller')
    if (!controller) continue
    const arg = controller.childForFieldName('arguments')!.namedChildren[0] ?? null
    const prefix =
      stringArg(arg) ??
      (arg?.type === 'object'
        ? stringArg(
            arg
              .descendantsOfType('pair')
              .find((p) => p!.childForFieldName('key')?.text === 'path')
              ?.childForFieldName('value') ?? null
          )
        : null) ??
      ''
    const className = klass!.childForFieldName('name')?.text ?? '<anonymous>'
    let pending: Node[] = []
    for (const member of klass!.childForFieldName('body')?.namedChildren ?? []) {
      if (!member) continue
      if (member.type === 'decorator') {
        pending.push(member)
        continue
      }
      if (member.type === 'method_definition') {
        for (const decorator of pending) {
          const call = decoratorCall(decorator)
          const name = call?.childForFieldName('function')?.text ?? decorator.namedChildren[0]?.text
          if (!name || !NEST_DECORATORS.has(name)) continue
          const path =
            stringArg(call?.childForFieldName('arguments')?.namedChildren[0] ?? null) ?? ''
          endpoints.push({
            method: name.toUpperCase(),
            path: joinPath(prefix, path),
            framework: 'nestjs',
            file,
            line: member.startPosition.row + 1,
            handler: `${className}.${member.childForFieldName('name')!.text}`,
          })
        }
      }
      pending = []
    }
  }
  return { endpoints, globalPrefix }
}

const NEXT_SEGMENT = (segment: string) =>
  segment.replace(/^\[\.\.\.(\w+)\]$/, '*$1').replace(/^\[(\w+)\]$/, ':$1')

/** Next.js: the file system is the router; App Router handlers export HTTP method functions. */
function nextEndpoints(path: string, root: Node | null): Endpoint[] {
  const pages = /^(?:src\/)?pages\/(.+)\.(tsx?|jsx?)$/.exec(path)
  const app = /^(?:src\/)?app\/(.*?)(?:^|\/)?(route|page)\.(tsx?|jsx?)$/.exec(path)
  const toRoute = (segments: string[]) =>
    joinPath(...segments.filter((s) => !/^\(.*\)$/.test(s) && s !== 'index').map(NEXT_SEGMENT))
  if (pages) {
    const segments = pages[1].split('/')
    if (segments[0].startsWith('_')) return []
    const route = toRoute(segments)
    if (segments[0] === 'api') {
      const checked = root
        ? Array.from(root.text.matchAll(/req\.method\s*[!=]==?\s*['"]([A-Z]+)['"]/g), (m) => m[1])
        : []
      const methods = checked.length ? Array.from(new Set(checked)) : ['ANY']
      return methods.map((method) => ({
        method,
        path: route,
        framework: 'nextjs',
        file: path,
        line: 1,
        handler: 'default',
      }))
    }
    return [
      { method: 'GET', path: route, framework: 'nextjs', file: path, line: 1, handler: 'default' },
    ]
  }
  if (app) {
    const route = toRoute(app[1].split('/'))
    if (app[2] === 'page')
      return [
        {
          method: 'GET',
          path: route,
          framework: 'nextjs',
          file: path,
          line: 1,
          handler: 'default',
        },
      ]
    const out: Endpoint[] = []
    for (const statement of root?.namedChildren ?? []) {
      if (statement?.type !== 'export_statement') continue
      const declaration = statement.childForFieldName('declaration')
      const name = declaration?.childForFieldName('name')?.text
      if (
        declaration?.type === 'function_declaration' &&
        name &&
        NEST_DECORATORS.has(name[0] + name.slice(1).toLowerCase())
      )
        out.push({
          method: name,
          path: route,
          framework: 'nextjs',
          file: path,
          line: statement.startPosition.row + 1,
          handler: name,
        })
    }
    return out
  }
  return []
}

/**
 * AdonisJS: routes on the default-imported `router` service — `router.get('/p', [Controller,
 * 'method'])`, verbs chaining `.as()`/`.use()`, and `router.group(() => {...}).prefix('/x')` whose
 * prefix composes onto the routes declared inside the closure. A `[Controller, 'method']` tuple is
 * the handler; a closure handler is unnamed (null).
 */
function adonisEndpoints(root: Node, file: string): Endpoint[] {
  const routers = new Set<string>()
  for (const statement of root.namedChildren) {
    if (statement?.type !== 'import_statement') continue
    if (stringArg(statement.childForFieldName('source')) !== ADONIS_ROUTER) continue
    const clause = statement.namedChildren.find((c) => c?.type === 'import_clause')
    const def = clause?.namedChildren.find((c) => c?.type === 'identifier')
    if (def) routers.add(def.text)
  }
  if (routers.size === 0) return []
  const isRouter = (n: Node | null) => n?.type === 'identifier' && routers.has(n.text)

  const handlerOf = (node: Node | null): string | null => {
    if (node?.type === 'array') {
      const els = node.namedChildren.filter((n): n is Node => n !== null)
      const ctrl = els[0]?.type === 'identifier' ? els[0].text : null
      const method = stringArg(els[1] ?? null)
      return ctrl ? (method ? `${ctrl}.${method}` : ctrl) : null
    }
    return stringArg(node)
  }
  // The prefix from a `.prefix('/x')` anywhere in the chain above a `.group(...)` call.
  const chainPrefix = (groupCall: Node): string => {
    let current: Node | null = groupCall
    for (let i = 0; i < 16 && current; i++) {
      const member: Node | null = current.parent
      // web-tree-sitter hands back a fresh wrapper per accessor call, so `object` is compared by
      // node id, not reference: the group call must be the object (left side) of the chain link.
      if (
        member?.type !== 'member_expression' ||
        member.childForFieldName('object')?.id !== current.id
      )
        break
      const outer: Node | null = member.parent
      if (outer?.type !== 'call_expression') break
      if (member.childForFieldName('property')?.text === 'prefix') {
        const arg =
          outer
            .childForFieldName('arguments')
            ?.namedChildren.find((a: Node | null) => a !== null) ?? null
        const p = stringArg(arg)
        if (p !== null) return p
      }
      current = outer
    }
    return ''
  }

  const groups: Array<{ start: number; end: number; prefix: string }> = []
  const routes: Array<{ endpoint: Endpoint; at: number }> = []
  for (const call of calls(root)) {
    const fn = call.childForFieldName('function')
    if (fn?.type !== 'member_expression' || !isRouter(fn.childForFieldName('object'))) continue
    const property = fn.childForFieldName('property')!.text
    const args = call
      .childForFieldName('arguments')!
      .namedChildren.filter((a): a is Node => a !== null)
    if (property === 'group' && isFunctionNode(args[0] ?? null)) {
      groups.push({ start: args[0].startIndex, end: args[0].endIndex, prefix: chainPrefix(call) })
    } else if (ADONIS_METHODS.has(property) && stringArg(args[0] ?? null) !== null) {
      routes.push({
        at: call.startIndex,
        endpoint: {
          method: property === 'any' ? 'ANY' : property.toUpperCase(),
          path: stringArg(args[0])!,
          framework: 'adonis',
          file,
          line: call.startPosition.row + 1,
          handler: handlerOf(args[1] ?? null),
        },
      })
    }
  }
  return routes.map(({ endpoint, at }) => {
    const prefixes = groups
      .filter((g) => g.start <= at && at <= g.end)
      .sort((a, b) => a.start - b.start)
      .map((g) => g.prefix)
    return { ...endpoint, path: joinPath(...prefixes, endpoint.path) }
  })
}

export async function extractEndpoints(files: Record<string, string>): Promise<Endpoint[]> {
  const express = new Map<string, FileRoutes>()
  const nest: Endpoint[] = []
  const next: Endpoint[] = []
  const adonis: Endpoint[] = []
  let globalPrefix = ''
  for (const [path, content] of Object.entries(files)) {
    if (path.includes('node_modules/') || !/\.(tsx?|jsx?|mjs|cjs)$/.test(path)) continue
    await withTree({ path, content, timeoutMs: PARSE_TIMEOUT_MS }, (root) => {
      express.set(path, expressFile(root))
      const nestResult = nestFile(root, path)
      nest.push(...nestResult.endpoints)
      if (nestResult.globalPrefix !== null) globalPrefix = nestResult.globalPrefix
      next.push(...nextEndpoints(path, root))
      adonis.push(...adonisEndpoints(root, path))
    })
  }
  return [
    ...composeExpress(express),
    ...nest.map((e) => ({ ...e, path: joinPath(globalPrefix, e.path) })),
    ...next,
    ...adonis,
  ].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
}
