/* eslint-disable prettier/prettier */
/// <reference path="../manifest.d.ts" />

import type { ExtractBody, ExtractErrorResponse, ExtractQuery, ExtractQueryForGet, ExtractResponse } from '@tuyau/core/types'
import type { InferInput, SimpleError } from '@vinejs/vine/types'

export type ParamValue = string | number | bigint | boolean

export interface Registry {
  'home': {
    methods: ["GET","HEAD"]
    pattern: '/'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/home_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/home_controller').default['index']>>>
    }
  }
  'healthz': {
    methods: ["GET","HEAD"]
    pattern: '/healthz'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: unknown
      errorResponse: unknown
    }
  }
  'auth.login': {
    methods: ["GET","HEAD"]
    pattern: '/auth/login'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/oidc_controller').default['start']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/oidc_controller').default['start']>>>
    }
  }
  'auth.callback': {
    methods: ["GET","HEAD"]
    pattern: '/auth/callback'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/oidc_controller').default['callback']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/oidc_controller').default['callback']>>>
    }
  }
  'auth.logout': {
    methods: ["POST"]
    pattern: '/auth/logout'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/oidc_controller').default['signOut']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/oidc_controller').default['signOut']>>>
    }
  }
  'api.me': {
    methods: ["GET","HEAD"]
    pattern: '/api/me'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/oidc_controller').default['me']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/oidc_controller').default['me']>>>
    }
  }
  'webhooks.github': {
    methods: ["POST"]
    pattern: '/webhooks/github/:hook'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { hook: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/webhooks_controller').default['github']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/webhooks_controller').default['github']>>>
    }
  }
  'workspaces.index': {
    methods: ["GET","HEAD"]
    pattern: '/workspaces'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/workspaces_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/workspaces_controller').default['index']>>>
    }
  }
  'workspaces.show': {
    methods: ["GET","HEAD"]
    pattern: '/w/:workspace'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { workspace: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/workspaces_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/workspaces_controller').default['show']>>>
    }
  }
  'workspaces.members': {
    methods: ["GET","HEAD"]
    pattern: '/api/w/:workspace/members'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { workspace: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/workspaces_controller').default['members']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/workspaces_controller').default['members']>>>
    }
  }
  'repositories.store': {
    methods: ["POST"]
    pattern: '/w/:workspace/repos'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/repository').registerRepositoryValidator)>>
      paramsTuple: [ParamValue]
      params: { workspace: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/repository').registerRepositoryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/repositories_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/repositories_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'repositories.files': {
    methods: ["GET","HEAD"]
    pattern: '/api/w/:workspace/r/:repository/files'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { workspace: ParamValue; repository: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/repositories_controller').default['files']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/repositories_controller').default['files']>>>
    }
  }
  'repositories.show': {
    methods: ["GET","HEAD"]
    pattern: '/w/:workspace/r/:repository'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { workspace: ParamValue; repository: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/repositories_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/repositories_controller').default['show']>>>
    }
  }
  'turns.scope': {
    methods: ["GET","HEAD"]
    pattern: '/api/w/:workspace/r/:repository/scope'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { workspace: ParamValue; repository: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/turns_controller').default['scope']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/turns_controller').default['scope']>>>
    }
  }
  'turns.stream': {
    methods: ["POST"]
    pattern: '/api/w/:workspace/r/:repository/turns'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/turn').turnValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { workspace: ParamValue; repository: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/turn').turnValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/turns_controller').default['stream']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/turns_controller').default['stream']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'decisions.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/w/:workspace/r/:repository/turns/:turn/decision'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue, ParamValue]
      params: { workspace: ParamValue; repository: ParamValue; turn: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/decisions_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/decisions_controller').default['show']>>>
    }
  }
  'decisions.review': {
    methods: ["POST"]
    pattern: '/api/w/:workspace/r/:repository/turns/:turn/review'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue, ParamValue]
      params: { workspace: ParamValue; repository: ParamValue; turn: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/decisions_controller').default['review']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/decisions_controller').default['review']>>>
    }
  }
  'new_account.create': {
    methods: ["GET","HEAD"]
    pattern: '/signup'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/new_account_controller').default['create']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/new_account_controller').default['create']>>>
    }
  }
  'new_account.store': {
    methods: ["POST"]
    pattern: '/signup'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/user').signupValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/user').signupValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/new_account_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/new_account_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'session.create': {
    methods: ["GET","HEAD"]
    pattern: '/login'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/session_controller').default['create']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/session_controller').default['create']>>>
    }
  }
  'session.store': {
    methods: ["POST"]
    pattern: '/login'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/user').loginValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/user').loginValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/session_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/session_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'session.destroy': {
    methods: ["POST"]
    pattern: '/logout'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/session_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/session_controller').default['destroy']>>>
    }
  }
}
