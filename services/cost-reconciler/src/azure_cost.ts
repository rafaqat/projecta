import {
  mergeTotals,
  type CostSource,
  type DailyTotal,
  type Window,
} from '../../../packages/cost/src/cost_source.js'

/**
 * Azure Cost Management query as a CostSource: actual cost, daily,
 * grouped by the `deployment` tag, mapped to model and environment through a
 * fixed table (grouping alignment is a deployment obligation). Authenticates
 * with a bearer token from managed identity; no inference credential exists
 * on this route. Pages follow `nextLink`.
 */
export interface AzureCostOptions {
  fetch: typeof fetch
  token: () => Promise<string>
  /** Cost Management scope, e.g. /subscriptions/<id> or a resource group. */
  scope: string
  environment: string
  deployments: Record<string, { model: string; environment: string }>
  managementUrl?: string
  apiVersion?: string
}

interface QueryPage {
  properties: {
    nextLink: string | null
    columns: Array<{ name: string }>
    rows: unknown[][]
  }
}

export class AzureCostManagementCostSource implements CostSource {
  readonly route = 'foundry' as const
  readonly environment: string

  constructor(private readonly options: AzureCostOptions) {
    this.environment = options.environment
  }

  async dailyTotals(window: Window): Promise<DailyTotal[]> {
    const base = this.options.managementUrl ?? 'https://management.azure.com'
    const apiVersion = this.options.apiVersion ?? '2023-11-01'
    const first = `${base}${this.options.scope}/providers/Microsoft.CostManagement/query?api-version=${apiVersion}`
    const query = {
      type: 'ActualCost',
      timeframe: 'Custom',
      timePeriod: { from: `${window.from}T00:00:00Z`, to: `${window.to}T23:59:59Z` },
      dataset: {
        granularity: 'Daily',
        aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
        grouping: [{ type: 'TagKey', name: 'deployment' }],
      },
    }
    const rows: DailyTotal[] = []
    let url: string | null = first
    for (let guard = 0; url && guard < 100; guard++) {
      const response = await this.options.fetch(url, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${await this.options.token()}`,
          'content-type': 'application/json',
          'accept': 'application/json',
        },
        body: JSON.stringify(query),
      })
      if (!response.ok) throw new Error(`cost management query answered ${response.status}`)
      const body = (await response.json()) as QueryPage
      const col = (name: string) => body.properties.columns.findIndex((c) => c.name === name)
      const [cost, date, tagValue, currency] = [
        col('Cost'),
        col('UsageDate'),
        col('TagValue'),
        col('Currency'),
      ]
      for (const r of body.properties.rows) {
        if (String(r[currency]) !== 'USD')
          throw new Error(`cost management currency ${String(r[currency])} is not USD`)
        const deployment = this.options.deployments[String(r[tagValue])]
        if (!deployment || deployment.environment !== this.environment) continue
        const raw = String(r[date])
        const day = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
        rows.push({
          day,
          route: 'foundry',
          environment: this.environment,
          model: deployment.model,
          costUsd: Number(r[cost]),
        })
      }
      url = body.properties.nextLink
    }
    return mergeTotals(rows)
  }
}
