# The evaluation specification

This is the "well-conditioned target": what *good* looks like, defined before the code that
must satisfy it. Three tiers gate the slices. Each tier is present from Phase 0 and reports
**red** until a slice turns its metrics green.

The gates and the per-branch lifecycle are in [`../docs/methodology.md`](../docs/methodology.md);
the founding decision is [ADR-0001](../docs/adr/0001-eval-first-vertical-slices.md).

## Tiers

### 1. Correctness — fixture repositories, deterministic oracles

Small, committed fixture repositories with known answers. Oracles derive expected values
from the fixture or a manifest, or hand-compute them — **never by calling the
implementation**.

| Metric | Measures | Target (initial) |
|---|---|---|
| Citation precision | share of cited statements that support the claim | ≥ 0.95 |
| Citation recall | share of claims that carry a citation | ≥ 0.90 |
| Retrieval hit-rate | the answer's evidence is retrieved for the question | ≥ 0.90 |
| Enumeration F1 | endpoints / dependencies listed, no more no fewer | ≥ 0.90 |
| Answerable accuracy | correct answer on in-scope questions | ≥ 0.90 |
| False refusal rate | in-scope questions wrongly refused | ≤ 0.02 |

### 2. Robustness — pinned real repositories, invariant thresholds

A fixed set of real, pinned public repositories (by commit SHA). We do not assert exact
answers on real code; we assert **invariants** — properties that must hold whatever the
answer — with thresholds and Wilson confidence intervals.

Examples of invariants: ingestion never crashes on a real repository; every answer that
makes a claim carries a citation into the ingested code; no answer cites a file outside the
repository; the same commit produces the same index.

### 3. Adversarial — owned suite, encoded fixtures

Prompt-injection and evasion payloads that the system must resist. Payloads are stored
**encoded** and decoded only into a temporary directory at test time; no plaintext payload
lives in the repository. Every mitigation has an **ablation flag** (compiled into test
targets only) so a canary proves the test can fail. The tier passes when mitigations **fail
closed**: a suspected injection withholds output rather than emitting it.

## Ground-truth policy

- Judgment labels are authored by a **person**. Until then a case carries
  `labelled_by: null` and is **not counted**.
- Computable oracles (values derivable from a fixture/manifest, or hand-computed) are
  authored with the case.
- No oracle calls the implementation under test.

## CI stance: ratchet and target

Every tier is reported two ways at once:

- **Ratchet** — the run **fails** if a metric regresses below the last accepted baseline.
- **Target** — the run **reports** the metric against its target above, every time, as a
  warning until met.

This lets CI be honest while early slices are legitimately red.

## Case layout

```
cases/correctness/    fixture-based cases with computable + human-labelled oracles
cases/robustness/     pinned-repo invariant cases (SHA-pinned)
cases/adversarial/    encoded payloads + ablation-gated expectations
runs/                 generated reports (git-ignored)
```

### Case schema (correctness)

```json
{
  "id": "cite-precision-001",
  "tier": "correctness",
  "fixture": "node-express-shop",
  "question": "Where is the cart total computed?",
  "oracle": {
    "kind": "citation",
    "expected_symbol": null,          // human-authored (judgment)
    "must_cite_file": "src/cart.js"   // computable from the fixture
  },
  "labelled_by": null                 // a person completes this
}
```

The harness that reads these cases and the runners that report each tier land on
`slice/00-constitution`; from Phase 0 they run and report **red**.
