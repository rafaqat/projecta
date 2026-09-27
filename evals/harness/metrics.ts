import type { Metric, Tier } from './types.ts'

/**
 * The well-conditioned target: what "good" means, fixed before the code that must meet it
 * (see evals/README.md). Each slice's job is to move its own metrics from red to green.
 */
export const TARGETS: Record<Tier, Metric[]> = {
  correctness: [
    { key: 'citation_precision', label: 'Citation precision', target: 0.95, direction: 'ge' },
    { key: 'citation_recall', label: 'Citation recall', target: 0.9, direction: 'ge' },
    { key: 'retrieval_hit_rate', label: 'Retrieval hit-rate', target: 0.9, direction: 'ge' },
    { key: 'enumeration_f1', label: 'Enumeration F1', target: 0.9, direction: 'ge' },
    { key: 'answerable_accuracy', label: 'Answerable accuracy', target: 0.9, direction: 'ge' },
    { key: 'false_refusal_rate', label: 'False refusal rate', target: 0.02, direction: 'le' },
  ],
  robustness: [
    { key: 'ingest_indexed', label: 'Ingest reaches indexed', target: 1, direction: 'ge' },
    { key: 'parse_timeouts', label: 'Parse timeouts within budget', target: 0, direction: 'le' },
    {
      key: 'peak_rss_bytes',
      label: 'Peak RSS within ceiling',
      target: 4294967296,
      direction: 'le',
    },
    { key: 'max_chunks_per_file', label: 'Max chunks per file', target: 1000, direction: 'le' },
  ],
  adversarial: [
    { key: 'injection_fail_closed', label: 'Injection fails closed', target: 1.0, direction: 'ge' },
    {
      key: 'no_plaintext_payload',
      label: 'No plaintext payload in repo',
      target: 1.0,
      direction: 'ge',
    },
  ],
}
