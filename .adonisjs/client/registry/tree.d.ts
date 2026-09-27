/* eslint-disable prettier/prettier */
import type { routes } from './index.ts'

export interface ApiDefinition {
  home: typeof routes['home']
  healthz: typeof routes['healthz']
  auth: {
    login: typeof routes['auth.login']
    callback: typeof routes['auth.callback']
    logout: typeof routes['auth.logout']
  }
  api: {
    me: typeof routes['api.me']
  }
  webhooks: {
    github: typeof routes['webhooks.github']
  }
  workspaces: {
    index: typeof routes['workspaces.index']
    show: typeof routes['workspaces.show']
    members: typeof routes['workspaces.members']
  }
  repositories: {
    store: typeof routes['repositories.store']
    files: typeof routes['repositories.files']
    show: typeof routes['repositories.show']
  }
  turns: {
    scope: typeof routes['turns.scope']
    stream: typeof routes['turns.stream']
  }
  decisions: {
    show: typeof routes['decisions.show']
    review: typeof routes['decisions.review']
  }
  newAccount: {
    create: typeof routes['new_account.create']
    store: typeof routes['new_account.store']
  }
  session: {
    create: typeof routes['session.create']
    store: typeof routes['session.store']
    destroy: typeof routes['session.destroy']
  }
}
