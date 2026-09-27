import type { LucideIcon } from 'lucide-react'
import { Building2, GitBranch, Layers, MessageSquareText, Moon, Sun, LogOut } from 'lucide-react'
import type { Scheme } from './scheme'

/**
 * Navigation derives from the props each page already carries: a
 * page that knows its workspace and repository gets crumbs and commands for
 * them; nothing here fetches or widens a presenter.
 */
export interface Named {
  handle: string
  name: string
}

export interface PageContext {
  component: string
  url: string
  workspace?: Named
  repository?: Named
  workspaces?: Named[]
  repositories?: Named[]
}

export interface Crumb {
  label: string
  href?: string
  icon?: LucideIcon
}

export function workspacePath(workspace: Named): string {
  return `/w/${workspace.handle}`
}

export function repositoryPath(workspace: Named, repository: Named): string {
  return `${workspacePath(workspace)}/r/${repository.handle}`
}

export function crumbsFor(page: PageContext): Crumb[] {
  const crumbs: Crumb[] = [{ label: 'Workspaces', href: '/workspaces', icon: Layers }]
  if (page.workspace) {
    crumbs.push({
      label: page.workspace.name,
      href: workspacePath(page.workspace),
      icon: Building2,
    })
    if (page.repository) {
      crumbs.push({
        label: page.repository.name,
        href: repositoryPath(page.workspace, page.repository),
        icon: GitBranch,
      })
    }
  }
  const last = crumbs[crumbs.length - 1]
  if (last.href === page.url.split('?')[0]) delete last.href
  return crumbs
}

export interface Command {
  group: 'Go to' | 'Actions'
  label: string
  icon: LucideIcon
  href?: string
  action?: 'scheme' | 'sign-out'
  kbd?: string
}

export function commandsFor(page: PageContext, scheme: Scheme): Command[] {
  const commands: Command[] = [
    { group: 'Go to', label: 'Workspaces', icon: Layers, href: '/workspaces', kbd: 'G W' },
  ]
  if (page.workspace) {
    commands.push({
      group: 'Go to',
      label: page.workspace.name,
      icon: Building2,
      href: workspacePath(page.workspace),
    })
    if (page.repository) {
      commands.push({
        group: 'Go to',
        label: `Ask ${page.repository.name}`,
        icon: MessageSquareText,
        href: repositoryPath(page.workspace, page.repository),
        kbd: 'G A',
      })
    }
    for (const repository of page.repositories ?? []) {
      commands.push({
        group: 'Go to',
        label: repository.name,
        icon: GitBranch,
        href: repositoryPath(page.workspace, repository),
      })
    }
  }
  for (const workspace of page.workspaces ?? []) {
    commands.push({
      group: 'Go to',
      label: workspace.name,
      icon: Building2,
      href: workspacePath(workspace),
    })
  }
  commands.push(
    {
      group: 'Actions',
      label: scheme === 'dark' ? 'Switch to light' : 'Switch to dark',
      icon: scheme === 'dark' ? Sun : Moon,
      action: 'scheme',
    },
    { group: 'Actions', label: 'Sign out', icon: LogOut, action: 'sign-out' }
  )
  return commands
}
