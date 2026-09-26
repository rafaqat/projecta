/**
 * Scorers (design §11). Every scorer is a pure function over a run's
 * observable outputs and a case's expectations, normalised the same way
 * (qualified symbols, paths, routes) before comparison.
 *
 * The correctness subset: the enumeration/route and citation scorers the fixture oracles
 * need. Scorers that
 * depend on the retrieval scope policy (common-word filtering, background
 * leakage, drift) and on a live `RunObservation` (selective accuracy,
 * attribution, failure attribution, flow scoring) belong to later slices and
 * are not ported here.
 */

export const norm = (s: string) => s.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()

export interface PR {
  precision: number | null
  recall: number | null
  f1: number | null
  hits: number
}

export function precisionRecall(expected: string[], actual: string[]): PR {
  const e = new Set(expected.map(norm))
  const a = new Set(actual.map(norm))
  let hits = 0
  for (const x of a) if (e.has(x)) hits++
  const precision = a.size ? hits / a.size : null
  const recall = e.size ? hits / e.size : null
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : precision === null || recall === null
        ? null
        : 0
  return { precision, recall, f1, hits }
}

/**
 * One spelling per route (WP-19, BL-17): method upper-cased, one trailing
 * slash removed, `{id}` and `<id>` written as `:id`. Equivalent forms of the
 * same endpoint must not read as recall failures.
 */
export function normRoute(route: string): string {
  const [method, ...rest] = route.trim().split(/\s+/)
  if (rest.length === 0) return norm(route)
  const path = rest
    .join(' ')
    .replace(/[{<]([^}>]+)[}>]/g, ':$1')
    .replace(/(.)\/+$/, '$1')
  return `${method.toUpperCase()} ${norm(path)}`
}

/** Enumeration: the answer's set against the expected set, one spelling per route. */
export const enumeration = (expected: string[], actual: string[]) =>
  precisionRecall(expected.map(normRoute), actual.map(normRoute))

/** A cited symbol may be path-qualified (`src/x.ts::A.b`); the symbol is what is compared. */
const unqualify = (symbol: string) => symbol.replace(/^[^:\s]+::/, '')

/** Citation coverage: cited symbols against gold provenance. */
export const citations = (expected: string[], cited: string[]) =>
  precisionRecall(expected.map(unqualify), cited.map(unqualify))
