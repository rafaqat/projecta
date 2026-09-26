import { test } from '@japa/runner'
import { isIdiom } from '#app/clones/detector'
import { symbolTokens } from '#app/clones/tokens'

/**
 * Framework handlers repeat by design (WP-19, BL-19; labelled
 * boilerplate-* cases): an Express-shaped `(req: Request, res: Response)`
 * handler is a pattern wherever it lives, not only under routes/.
 */
const HANDLERS = `import type { Request, Response } from 'express'
export async function getOrders(req: Request, res: Response): Promise<void> {
  const page = Number(req.query.page ?? 1)
  const rows = await req.app.locals.db.from('orders').where('user_id', req.params.userId).page(page)
  res.status(200).json({ page, rows })
}
export function sumAll(values: number[]): number {
  let total = 0
  for (const value of values) total = total + value
  return total
}
`

test.group('clone idioms (WP-19)', () => {
  test('a request/response handler outside routes/ is an idiom; an ordinary function is not', async ({
    assert,
  }) => {
    const symbols = await symbolTokens('src/boilerplate/handlers.ts', HANDLERS)
    const byName = new Map(symbols.map((s) => [s.qualifiedName, s]))
    assert.isTrue(isIdiom(byName.get('getOrders')!))
    assert.isFalse(isIdiom(byName.get('sumAll')!))
  }).tags(['AC-WP19-06', 'wp19'])
})

/**
 * Kotlin and Android boilerplate repeats by design too: Room DAOs
 * and entities, Hilt modules, Compose previews, RecyclerView adapters'
 * view holders. An ordinary Kotlin function is not an idiom.
 */
const ANDROID = `package com.example.birthdays.persistence

import androidx.room.Dao
import androidx.room.Query

@Dao
interface EventDao {
    @Query("SELECT * FROM events")
    fun all(): List<Event>
}

class EventAdapter : RecyclerView.Adapter<EventAdapter.EventViewHolder>() {
    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): EventViewHolder {
        val view = LayoutInflater.from(parent.context).inflate(R.layout.row_event, parent, false)
        return EventViewHolder(view)
    }
}

fun daysUntil(today: Int, day: Int): Int {
    var total = day - today
    if (total < 0) total = total + 365
    return total
}
`

test.group('clone idioms: Kotlin', () => {
  test('Room DAOs and RecyclerView adapter methods are idioms; an ordinary Kotlin function is not', async ({
    assert,
  }) => {
    const symbols = await symbolTokens(
      'app/src/main/java/com/example/birthdays/persistence/EventDao.kt',
      ANDROID
    )
    const byName = new Map(symbols.map((s) => [s.qualifiedName, s]))
    assert.includeMembers(
      [...byName.keys()],
      ['EventDao', 'EventAdapter.onCreateViewHolder', 'daysUntil']
    )
    assert.isTrue(isIdiom(byName.get('EventDao')!))
    assert.isTrue(isIdiom(byName.get('EventAdapter.onCreateViewHolder')!))
    assert.isFalse(isIdiom(byName.get('daysUntil')!))
  }).tags(['AC-WP19-06', 'wp19'])
})
