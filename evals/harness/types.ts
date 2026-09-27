export type Tier = 'correctness' | 'robustness' | 'adversarial'
export type Direction = 'ge' | 'le'

/** A target defines what "good" means for one metric, before any code exists to meet it. */
export interface Metric {
  key: string
  label: string
  target: number
  direction: Direction
}

export interface EvalCase {
  id: string
  tier: Tier
  /** Ground truth is human-authored: null until a person labels it, and then it is counted. */
  labelled_by: string | null
  [key: string]: unknown
}

export interface MetricResult {
  key: string
  label: string
  target: number
  direction: Direction
  /** null = not yet measurable (no system under test). A null actual is red against any target. */
  actual: number | null
  met: boolean
}

export interface TierReport {
  tier: Tier
  cases: number
  labelled: number
  pending: number
  metrics: MetricResult[]
}

export interface RunReport {
  generatedAt: string
  tiers: TierReport[]
}
