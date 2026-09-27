import { test } from '@japa/runner'
import { resetDatabase } from '#tests/helpers/db'

/**
 * What a signed-out visitor is actually shown. This asserts the rendered page rather than a
 * redirect, so it belongs with the interface: the rest of the landing rules are header assertions
 * and live in landing.spec.ts.
 */

/** The Inertia page object embedded in a server-rendered response (SSR is off in tests). */
function inertiaPage(html: string): { component: string; props: Record<string, unknown> } {
  const match = html.match(/<script data-page="[^"]+" type="application\/json">(.*?)<\/script>/s)
  if (!match) throw new Error('no inertia page payload in response')
  return JSON.parse(match[1])
}

test.group('Landing page for a signed-out visitor', (group) => {
  group.each.setup(() => resetDatabase())

  test('a signed-out visitor to / sees the sign-in page, not the starter page', async ({
    client,
  }) => {
    const home = await client.get('/').redirects(0)
    home.assertStatus(200)
    const page = inertiaPage(home.text())
    if (page.component !== 'home') throw new Error(`rendered ${page.component}`)
    if (page.props.user) throw new Error('signed-out visitor has a user prop')
  }).tags(['wp02'])
})
