import '@adonisjs/core/types/http'

type ParamValue = string | number | bigint | boolean

export type ScannedRoutes = {
  ALL: {
    'home': { paramsTuple?: []; params?: {} }
    'healthz': { paramsTuple?: []; params?: {} }
    'auth.login': { paramsTuple?: []; params?: {} }
    'auth.callback': { paramsTuple?: []; params?: {} }
    'auth.logout': { paramsTuple?: []; params?: {} }
    'api.me': { paramsTuple?: []; params?: {} }
    'webhooks.github': { paramsTuple: [ParamValue]; params: {'hook': ParamValue} }
    'workspaces.index': { paramsTuple?: []; params?: {} }
    'workspaces.show': { paramsTuple: [ParamValue]; params: {'workspace': ParamValue} }
    'workspaces.members': { paramsTuple: [ParamValue]; params: {'workspace': ParamValue} }
    'repositories.store': { paramsTuple: [ParamValue]; params: {'workspace': ParamValue} }
    'repositories.files': { paramsTuple: [ParamValue,ParamValue]; params: {'workspace': ParamValue,'repository': ParamValue} }
    'repositories.show': { paramsTuple: [ParamValue,ParamValue]; params: {'workspace': ParamValue,'repository': ParamValue} }
    'turns.scope': { paramsTuple: [ParamValue,ParamValue]; params: {'workspace': ParamValue,'repository': ParamValue} }
    'turns.stream': { paramsTuple: [ParamValue,ParamValue]; params: {'workspace': ParamValue,'repository': ParamValue} }
    'decisions.show': { paramsTuple: [ParamValue,ParamValue,ParamValue]; params: {'workspace': ParamValue,'repository': ParamValue,'turn': ParamValue} }
    'decisions.review': { paramsTuple: [ParamValue,ParamValue,ParamValue]; params: {'workspace': ParamValue,'repository': ParamValue,'turn': ParamValue} }
    'new_account.create': { paramsTuple?: []; params?: {} }
    'new_account.store': { paramsTuple?: []; params?: {} }
    'session.create': { paramsTuple?: []; params?: {} }
    'session.store': { paramsTuple?: []; params?: {} }
    'session.destroy': { paramsTuple?: []; params?: {} }
  }
  GET: {
    'home': { paramsTuple?: []; params?: {} }
    'healthz': { paramsTuple?: []; params?: {} }
    'auth.login': { paramsTuple?: []; params?: {} }
    'auth.callback': { paramsTuple?: []; params?: {} }
    'api.me': { paramsTuple?: []; params?: {} }
    'workspaces.index': { paramsTuple?: []; params?: {} }
    'workspaces.show': { paramsTuple: [ParamValue]; params: {'workspace': ParamValue} }
    'workspaces.members': { paramsTuple: [ParamValue]; params: {'workspace': ParamValue} }
    'repositories.files': { paramsTuple: [ParamValue,ParamValue]; params: {'workspace': ParamValue,'repository': ParamValue} }
    'repositories.show': { paramsTuple: [ParamValue,ParamValue]; params: {'workspace': ParamValue,'repository': ParamValue} }
    'turns.scope': { paramsTuple: [ParamValue,ParamValue]; params: {'workspace': ParamValue,'repository': ParamValue} }
    'decisions.show': { paramsTuple: [ParamValue,ParamValue,ParamValue]; params: {'workspace': ParamValue,'repository': ParamValue,'turn': ParamValue} }
    'new_account.create': { paramsTuple?: []; params?: {} }
    'session.create': { paramsTuple?: []; params?: {} }
  }
  HEAD: {
    'home': { paramsTuple?: []; params?: {} }
    'healthz': { paramsTuple?: []; params?: {} }
    'auth.login': { paramsTuple?: []; params?: {} }
    'auth.callback': { paramsTuple?: []; params?: {} }
    'api.me': { paramsTuple?: []; params?: {} }
    'workspaces.index': { paramsTuple?: []; params?: {} }
    'workspaces.show': { paramsTuple: [ParamValue]; params: {'workspace': ParamValue} }
    'workspaces.members': { paramsTuple: [ParamValue]; params: {'workspace': ParamValue} }
    'repositories.files': { paramsTuple: [ParamValue,ParamValue]; params: {'workspace': ParamValue,'repository': ParamValue} }
    'repositories.show': { paramsTuple: [ParamValue,ParamValue]; params: {'workspace': ParamValue,'repository': ParamValue} }
    'turns.scope': { paramsTuple: [ParamValue,ParamValue]; params: {'workspace': ParamValue,'repository': ParamValue} }
    'decisions.show': { paramsTuple: [ParamValue,ParamValue,ParamValue]; params: {'workspace': ParamValue,'repository': ParamValue,'turn': ParamValue} }
    'new_account.create': { paramsTuple?: []; params?: {} }
    'session.create': { paramsTuple?: []; params?: {} }
  }
  POST: {
    'auth.logout': { paramsTuple?: []; params?: {} }
    'webhooks.github': { paramsTuple: [ParamValue]; params: {'hook': ParamValue} }
    'repositories.store': { paramsTuple: [ParamValue]; params: {'workspace': ParamValue} }
    'turns.stream': { paramsTuple: [ParamValue,ParamValue]; params: {'workspace': ParamValue,'repository': ParamValue} }
    'decisions.review': { paramsTuple: [ParamValue,ParamValue,ParamValue]; params: {'workspace': ParamValue,'repository': ParamValue,'turn': ParamValue} }
    'new_account.store': { paramsTuple?: []; params?: {} }
    'session.store': { paramsTuple?: []; params?: {} }
    'session.destroy': { paramsTuple?: []; params?: {} }
  }
}
declare module '@adonisjs/core/types/http' {
  export interface RoutesList extends ScannedRoutes {}
}