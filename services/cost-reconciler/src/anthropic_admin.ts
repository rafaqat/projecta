import {
  mergeTotals,
  type CostSource,
  type DailyTotal,
  type Window,
} from '../../../packages/cost/src/cost_source.js'

/**
 * Anthropic Admin API cost report as a CostSource: daily buckets
 * grouped by workspace and model, this environment's workspace only, pages
 * followed until `has_more` is false. The Admin key lives here and nowhere
 * else in the system. Amounts are decimal USD strings; confirm against the
 * first live response and record the evidence link in the ADR.
 */
export interface AnthropicAdminOptions {
  fetch: typeof fetch
  adminKey: string
  workspaceId: string
  environment: string
  baseUrl?: string
}

interface CostReportPage {
  data: Array<{
    starting_at: string
    results: Array<{
      currency: string
      amount: string
      workspace_id: string | null
      model: string | null
    }>
  }>
  has_more: boolean
  next_page: string | null
}

export class AnthropicAdminCostSource implements CostSource {
  readonly route = 'anthropic' as const
  readonly environment: string

  constructor(private readonly options: AnthropicAdminOptions) {
    this.environment = options.environment
  }

  async dailyTotals(window: Window): Promise<DailyTotal[]> {
    const base = this.options.baseUrl ?? 'https://api.anthropic.com'
    const rows: DailyTotal[] = []
    let page: string | null = null
    for (let guard = 0; guard < 100; guard++) {
      const url = new URL('/v1/organizations/cost_report', base)
      url.searchParams.set('starting_at', `${window.from}T00:00:00Z`)
      url.searchParams.set('ending_at', `${nextDay(window.to)}T00:00:00Z`)
      url.searchParams.set('bucket_width', '1d')
      url.searchParams.append('group_by[]', 'workspace_id')
      url.searchParams.append('group_by[]', 'model')
      if (page) url.searchParams.set('page', page)
      const response = await this.options.fetch(url, {
        headers: {
          'x-api-key': this.options.adminKey,
          'anthropic-version': '2023-06-01',
          'accept': 'application/json',
        },
      })
      if (!response.ok) throw new Error(`cost_report answered ${response.status}`)
      const body = (await response.json()) as CostReportPage
      for (const bucket of body.data) {
        const day = bucket.starting_at.slice(0, 10)
        for (const r of bucket.results) {
          if (r.workspace_id !== this.options.workspaceId || !r.model) continue
          if (r.currency !== 'USD') throw new Error(`cost_report currency ${r.currency} is not USD`)
          rows.push({
            day,
            route: 'anthropic',
            environment: this.environment,
            model: r.model,
            costUsd: Number(r.amount),
          })
        }
      }
      if (!body.has_more || !body.next_page) break
      page = body.next_page
    }
    return mergeTotals(rows)
  }
}

function nextDay(iso: string): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
}
