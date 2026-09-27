import type { HttpContext } from '@adonisjs/core/http'

/**
 * Render an Inertia page by name.
 *
 * Inertia types `render()` against a page registry generated from the page components present in the
 * tree. A vertical slice that carries a controller but not the web UI has an empty registry, so no
 * page name would satisfy it and the controller could not type-check on its own. The name is therefore
 * handed over unchecked, in this one place rather than at every call site. What actually catches a
 * wrong page name is the browser suite, which renders each page for real.
 */
export function renderPage(
  inertia: HttpContext['inertia'],
  page: string,
  props: Record<string, unknown> = {}
) {
  // Bound, not detached: render() is a method and relies on its receiver.
  const render = inertia.render.bind(inertia) as unknown as (
    component: string,
    pageProps: Record<string, unknown>
  ) => unknown
  return render(page, props)
}
