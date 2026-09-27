/* eslint-disable prettier/prettier */
import type { AdonisEndpoint } from '@tuyau/core/types'
import type { Registry } from './schema.d.ts'
import type { ApiDefinition } from './tree.d.ts'

const placeholder: any = {}

const routes = {
  'home': {
    methods: ["GET","HEAD"],
    pattern: '/',
    tokens: [{"old":"/","type":0,"val":"/","end":""}],
    types: placeholder as Registry['home']['types'],
  },
  'healthz': {
    methods: ["GET","HEAD"],
    pattern: '/healthz',
    tokens: [{"old":"/healthz","type":0,"val":"healthz","end":""}],
    types: placeholder as Registry['healthz']['types'],
  },
  'auth.login': {
    methods: ["GET","HEAD"],
    pattern: '/auth/login',
    tokens: [{"old":"/auth/login","type":0,"val":"auth","end":""},{"old":"/auth/login","type":0,"val":"login","end":""}],
    types: placeholder as Registry['auth.login']['types'],
  },
  'auth.callback': {
    methods: ["GET","HEAD"],
    pattern: '/auth/callback',
    tokens: [{"old":"/auth/callback","type":0,"val":"auth","end":""},{"old":"/auth/callback","type":0,"val":"callback","end":""}],
    types: placeholder as Registry['auth.callback']['types'],
  },
  'auth.logout': {
    methods: ["POST"],
    pattern: '/auth/logout',
    tokens: [{"old":"/auth/logout","type":0,"val":"auth","end":""},{"old":"/auth/logout","type":0,"val":"logout","end":""}],
    types: placeholder as Registry['auth.logout']['types'],
  },
  'api.me': {
    methods: ["GET","HEAD"],
    pattern: '/api/me',
    tokens: [{"old":"/api/me","type":0,"val":"api","end":""},{"old":"/api/me","type":0,"val":"me","end":""}],
    types: placeholder as Registry['api.me']['types'],
  },
  'webhooks.github': {
    methods: ["POST"],
    pattern: '/webhooks/github/:hook',
    tokens: [{"old":"/webhooks/github/:hook","type":0,"val":"webhooks","end":""},{"old":"/webhooks/github/:hook","type":0,"val":"github","end":""},{"old":"/webhooks/github/:hook","type":1,"val":"hook","end":""}],
    types: placeholder as Registry['webhooks.github']['types'],
  },
  'workspaces.index': {
    methods: ["GET","HEAD"],
    pattern: '/workspaces',
    tokens: [{"old":"/workspaces","type":0,"val":"workspaces","end":""}],
    types: placeholder as Registry['workspaces.index']['types'],
  },
  'workspaces.show': {
    methods: ["GET","HEAD"],
    pattern: '/w/:workspace',
    tokens: [{"old":"/w/:workspace","type":0,"val":"w","end":""},{"old":"/w/:workspace","type":1,"val":"workspace","end":""}],
    types: placeholder as Registry['workspaces.show']['types'],
  },
  'workspaces.members': {
    methods: ["GET","HEAD"],
    pattern: '/api/w/:workspace/members',
    tokens: [{"old":"/api/w/:workspace/members","type":0,"val":"api","end":""},{"old":"/api/w/:workspace/members","type":0,"val":"w","end":""},{"old":"/api/w/:workspace/members","type":1,"val":"workspace","end":""},{"old":"/api/w/:workspace/members","type":0,"val":"members","end":""}],
    types: placeholder as Registry['workspaces.members']['types'],
  },
  'repositories.store': {
    methods: ["POST"],
    pattern: '/w/:workspace/repos',
    tokens: [{"old":"/w/:workspace/repos","type":0,"val":"w","end":""},{"old":"/w/:workspace/repos","type":1,"val":"workspace","end":""},{"old":"/w/:workspace/repos","type":0,"val":"repos","end":""}],
    types: placeholder as Registry['repositories.store']['types'],
  },
  'repositories.files': {
    methods: ["GET","HEAD"],
    pattern: '/api/w/:workspace/r/:repository/files',
    tokens: [{"old":"/api/w/:workspace/r/:repository/files","type":0,"val":"api","end":""},{"old":"/api/w/:workspace/r/:repository/files","type":0,"val":"w","end":""},{"old":"/api/w/:workspace/r/:repository/files","type":1,"val":"workspace","end":""},{"old":"/api/w/:workspace/r/:repository/files","type":0,"val":"r","end":""},{"old":"/api/w/:workspace/r/:repository/files","type":1,"val":"repository","end":""},{"old":"/api/w/:workspace/r/:repository/files","type":0,"val":"files","end":""}],
    types: placeholder as Registry['repositories.files']['types'],
  },
  'repositories.show': {
    methods: ["GET","HEAD"],
    pattern: '/w/:workspace/r/:repository',
    tokens: [{"old":"/w/:workspace/r/:repository","type":0,"val":"w","end":""},{"old":"/w/:workspace/r/:repository","type":1,"val":"workspace","end":""},{"old":"/w/:workspace/r/:repository","type":0,"val":"r","end":""},{"old":"/w/:workspace/r/:repository","type":1,"val":"repository","end":""}],
    types: placeholder as Registry['repositories.show']['types'],
  },
  'turns.scope': {
    methods: ["GET","HEAD"],
    pattern: '/api/w/:workspace/r/:repository/scope',
    tokens: [{"old":"/api/w/:workspace/r/:repository/scope","type":0,"val":"api","end":""},{"old":"/api/w/:workspace/r/:repository/scope","type":0,"val":"w","end":""},{"old":"/api/w/:workspace/r/:repository/scope","type":1,"val":"workspace","end":""},{"old":"/api/w/:workspace/r/:repository/scope","type":0,"val":"r","end":""},{"old":"/api/w/:workspace/r/:repository/scope","type":1,"val":"repository","end":""},{"old":"/api/w/:workspace/r/:repository/scope","type":0,"val":"scope","end":""}],
    types: placeholder as Registry['turns.scope']['types'],
  },
  'turns.stream': {
    methods: ["POST"],
    pattern: '/api/w/:workspace/r/:repository/turns',
    tokens: [{"old":"/api/w/:workspace/r/:repository/turns","type":0,"val":"api","end":""},{"old":"/api/w/:workspace/r/:repository/turns","type":0,"val":"w","end":""},{"old":"/api/w/:workspace/r/:repository/turns","type":1,"val":"workspace","end":""},{"old":"/api/w/:workspace/r/:repository/turns","type":0,"val":"r","end":""},{"old":"/api/w/:workspace/r/:repository/turns","type":1,"val":"repository","end":""},{"old":"/api/w/:workspace/r/:repository/turns","type":0,"val":"turns","end":""}],
    types: placeholder as Registry['turns.stream']['types'],
  },
  'decisions.show': {
    methods: ["GET","HEAD"],
    pattern: '/api/w/:workspace/r/:repository/turns/:turn/decision',
    tokens: [{"old":"/api/w/:workspace/r/:repository/turns/:turn/decision","type":0,"val":"api","end":""},{"old":"/api/w/:workspace/r/:repository/turns/:turn/decision","type":0,"val":"w","end":""},{"old":"/api/w/:workspace/r/:repository/turns/:turn/decision","type":1,"val":"workspace","end":""},{"old":"/api/w/:workspace/r/:repository/turns/:turn/decision","type":0,"val":"r","end":""},{"old":"/api/w/:workspace/r/:repository/turns/:turn/decision","type":1,"val":"repository","end":""},{"old":"/api/w/:workspace/r/:repository/turns/:turn/decision","type":0,"val":"turns","end":""},{"old":"/api/w/:workspace/r/:repository/turns/:turn/decision","type":1,"val":"turn","end":""},{"old":"/api/w/:workspace/r/:repository/turns/:turn/decision","type":0,"val":"decision","end":""}],
    types: placeholder as Registry['decisions.show']['types'],
  },
  'decisions.review': {
    methods: ["POST"],
    pattern: '/api/w/:workspace/r/:repository/turns/:turn/review',
    tokens: [{"old":"/api/w/:workspace/r/:repository/turns/:turn/review","type":0,"val":"api","end":""},{"old":"/api/w/:workspace/r/:repository/turns/:turn/review","type":0,"val":"w","end":""},{"old":"/api/w/:workspace/r/:repository/turns/:turn/review","type":1,"val":"workspace","end":""},{"old":"/api/w/:workspace/r/:repository/turns/:turn/review","type":0,"val":"r","end":""},{"old":"/api/w/:workspace/r/:repository/turns/:turn/review","type":1,"val":"repository","end":""},{"old":"/api/w/:workspace/r/:repository/turns/:turn/review","type":0,"val":"turns","end":""},{"old":"/api/w/:workspace/r/:repository/turns/:turn/review","type":1,"val":"turn","end":""},{"old":"/api/w/:workspace/r/:repository/turns/:turn/review","type":0,"val":"review","end":""}],
    types: placeholder as Registry['decisions.review']['types'],
  },
  'new_account.create': {
    methods: ["GET","HEAD"],
    pattern: '/signup',
    tokens: [{"old":"/signup","type":0,"val":"signup","end":""}],
    types: placeholder as Registry['new_account.create']['types'],
  },
  'new_account.store': {
    methods: ["POST"],
    pattern: '/signup',
    tokens: [{"old":"/signup","type":0,"val":"signup","end":""}],
    types: placeholder as Registry['new_account.store']['types'],
  },
  'session.create': {
    methods: ["GET","HEAD"],
    pattern: '/login',
    tokens: [{"old":"/login","type":0,"val":"login","end":""}],
    types: placeholder as Registry['session.create']['types'],
  },
  'session.store': {
    methods: ["POST"],
    pattern: '/login',
    tokens: [{"old":"/login","type":0,"val":"login","end":""}],
    types: placeholder as Registry['session.store']['types'],
  },
  'session.destroy': {
    methods: ["POST"],
    pattern: '/logout',
    tokens: [{"old":"/logout","type":0,"val":"logout","end":""}],
    types: placeholder as Registry['session.destroy']['types'],
  },
} as const satisfies Record<string, AdonisEndpoint>

export { routes }

export const registry = {
  routes,
  $tree: {} as ApiDefinition,
}

declare module '@tuyau/core/types' {
  export interface UserRegistry {
    routes: typeof routes
    $tree: ApiDefinition
  }
}
