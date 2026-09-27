import { useEffect, useState, type ReactNode } from 'react'
import { matchesRepository } from '~/pages/workspaces/show'
import { router } from '@inertiajs/react'
import { Link } from '@adonisjs/inertia/react'
import {
  Building2,
  Copy,
  GitBranch,
  Info,
  Layers,
  LogOut,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Sun,
} from 'lucide-react'
import type { Data } from '@generated/data'
import { IconButton } from '~/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown_menu'
import { Breadcrumbs } from './breadcrumbs'
import { CommandPalette } from './command_palette'
import {
  commandsFor,
  crumbsFor,
  repositoryPath,
  workspacePath,
  type Command,
  type PageContext,
} from '~/lib/navigation'
import { applyScheme, currentScheme, type Scheme } from '~/lib/scheme'

/**
 * The persistent shell (design prototype): header with workspace, breadcrumbs,
 * search and user menu; a collapsible rail; the page in a rounded panel.
 * Everything it shows comes from the current page's props.
 */
export function AppShell({
  page,
  user,
  children,
}: {
  page: PageContext
  user: NonNullable<Data.SharedProps['user']>
  children: ReactNode
}) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('sidebar-hidden') === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('sidebar-hidden', collapsed ? '1' : '0')
    } catch {
      // Per-viewer convenience only; web storage can be blocked (private mode) — the toggle still works.
    }
  }, [collapsed])
  const [palette, setPalette] = useState(false)
  const [repositoryQuery, setRepositoryQuery] = useState('')
  const [scheme, setScheme] = useState<Scheme>(currentScheme)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((p) => !p)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggleScheme = () => {
    const next: Scheme = scheme === 'dark' ? 'light' : 'dark'
    applyScheme(next)
    setScheme(next)
  }
  const signOut = () => {
    // The app writes nothing to web storage, but clear it defensively so a sign-out leaves no
    // client-side trace behind (a browser extension or a future feature may have written something).
    try {
      localStorage.clear()
      sessionStorage.clear()
    } catch {
      // Storage can throw in private mode or when blocked; a sign-out must proceed regardless.
    }
    router.post('/auth/logout')
  }
  const run = (command: Command) => {
    setPalette(false)
    if (command.href) router.visit(command.href)
    if (command.action === 'scheme') toggleScheme()
    if (command.action === 'sign-out') signOut()
  }

  // Header brand keeps its home link visible even when the sidebar is hidden (just the mark);
  // the sidebar itself collapses to zero width, handing all the space to the middle panel.
  const railWidth = collapsed ? 'w-auto' : 'w-[244px]'
  const asideWidth = collapsed ? 'w-0 pl-0 pr-0' : 'w-[244px]'
  const path = page.url.split('?')[0]
  const nav: Array<{ href: string; label: string; icon: typeof Layers; active: boolean }> = [
    { href: '/workspaces', label: 'Workspaces', icon: Layers, active: path === '/workspaces' },
  ]
  // Workspaces → this workspace; the repository is the highlighted entry of the list below
  // (UAT 2026-09-15: a third item labelled "Ask" read as a separate place, not the repository).
  if (page.workspace) {
    const href = workspacePath(page.workspace)
    nav.push({ href, label: page.workspace.name, icon: Building2, active: path === href })
  }
  // A repository in scope shows its browsable index pages: Duplicates.
  if (page.workspace && page.repository) {
    const repo = repositoryPath(page.workspace, page.repository)
    nav.push({
      href: `${repo}/duplicates`,
      label: 'Duplicates',
      icon: Copy,
      active: path === `${repo}/duplicates`,
    })
  }
  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex h-12 flex-none items-center gap-1.5 pr-2.5">
        <div className={`flex flex-none items-center pl-2.5 transition-[width] ${railWidth}`}>
          <Link
            href={page.workspace ? workspacePath(page.workspace) : '/workspaces'}
            className="ghost flex h-8 min-w-0 items-center gap-2 px-1.5"
          >
            <span className="mark grid h-5 w-5 flex-none place-items-center rounded-md text-[10.5px] font-semibold">
              {(page.workspace?.name ?? 'W').slice(0, 1).toUpperCase()}
            </span>
            {!collapsed ? (
              <span className="truncate font-medium text-content-primary">
                {page.workspace?.name ?? 'Workspaces'}
              </span>
            ) : null}
          </Link>
        </div>
        <IconButton
          label={collapsed ? 'Show sidebar' : 'Hide sidebar'}
          onClick={() => setCollapsed(!collapsed)}
          data-toggle-sidebar
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </IconButton>
        <Breadcrumbs items={crumbsFor(page)} />
        <button
          type="button"
          onClick={() => setPalette(true)}
          className="ghost outline-ring flex h-8 w-[220px] flex-none items-center gap-2 px-2.5 text-content-muted"
          data-open-palette
        >
          <Search className="h-3.5 w-3.5" />
          <span>Search</span>
          <span className="kbd ml-auto">⌘K</span>
        </button>
        <IconButton label="Toggle theme" onClick={toggleScheme} data-toggle-scheme>
          {scheme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        </IconButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="ghost grid h-8 w-8 place-items-center"
              aria-label="Account"
            >
              <span className="avatar h-6 w-6 text-[10px]">{user.initials}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[230px]">
            <DropdownMenuLabel>
              <div className="truncate text-[13px] font-medium text-content-primary">
                {user.fullName}
              </div>
              <div className="truncate font-normal">{user.email}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={signOut}>
              <LogOut className="h-3.5 w-3.5 text-content-muted" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          aria-label="Primary"
          className={`flex flex-none flex-col gap-0.5 overflow-hidden pb-2 pl-2.5 pr-2 transition-[width] ${asideWidth}`}
        >
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              data-active={item.active}
              className={`nav-item flex h-8 items-center gap-2.5 text-left ${collapsed ? 'w-9 justify-center' : 'w-full px-2'}`}
            >
              <item.icon className="h-4 w-4 flex-none" />
              {!collapsed ? <span className="truncate">{item.label}</span> : null}
            </Link>
          ))}
          {!collapsed && page.repositories?.length ? (
            <div data-sidebar-repositories>
              <div className="px-2 pb-1 pt-3.5 text-[11.5px] font-medium text-content-muted">
                Repositories
              </div>
              {page.repositories.length > 5 ? (
                <input
                  type="search"
                  value={repositoryQuery}
                  onChange={(e) => setRepositoryQuery(e.target.value)}
                  placeholder="Find…"
                  aria-label="Find a repository"
                  className="field mb-1 h-7 w-full px-2 text-[12.5px]"
                  data-sidebar-repository-filter
                />
              ) : null}
              {page.repositories
                .filter((repository) => matchesRepository(repositoryQuery, repository))
                .map((repository) => (
                  <Link
                    key={repository.handle}
                    href={repositoryPath(page.workspace!, repository)}
                    data-active={page.repository?.handle === repository.handle}
                    className="nav-item flex h-7 w-full items-center gap-2.5 px-2 text-left"
                  >
                    <GitBranch className="h-4 w-4 flex-none" />
                    <span className="truncate">{repository.name}</span>
                  </Link>
                ))}
            </div>
          ) : null}
          {/* Deployment-level, not workspace-scoped: pinned to the bottom so it is always reachable,
              the prominent home for what was only a link beside the decision record's configHash. */}
          <Link
            href="/about"
            title={collapsed ? 'About this deployment' : undefined}
            data-active={path === '/about'}
            data-nav-about
            className={`nav-item mt-auto flex h-8 items-center gap-2.5 text-left ${collapsed ? 'w-9 justify-center' : 'w-full px-2'}`}
          >
            <Info className="h-4 w-4 flex-none" />
            {!collapsed ? <span className="truncate">About this deployment</span> : null}
          </Link>
        </aside>
        <main className="panel mb-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-[10px]">
          {children}
        </main>
      </div>
      <CommandPalette
        open={palette}
        onOpenChange={setPalette}
        commands={commandsFor(page, scheme)}
        onRun={run}
      />
    </div>
  )
}
