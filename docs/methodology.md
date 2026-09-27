# Methodology: eval-first, testable vertical slices

This repository is built by a fixed method. The method is the point as much as the product.

## 1. Decide, measure, then build

The order is deliberate:

1. **Decide.** A decision that shapes the architecture is written as an Architecture
   Decision Record (ADR) in [`adr/`](adr/) *before* it is implemented. Accepted ADRs are
   immutable; a decision changes only by a superseding ADR.
2. **Measure.** The evaluation tiers and their target thresholds (see
   [`../evals/README.md`](../evals/README.md)) are defined before the code they grade.
   Early slices show these evals **red**. That is not a broken build — it is the target we
   have not yet met.
3. **Build.** A vertical slice turns its own metrics green.

## 2. A branch is a deployable slice

Each milestone is one branch, `slice/NN-<name>`, that cuts through the whole stack and
delivers a user-visible capability. The lifecycle of every slice branch:

1. Open `slice/NN-*` from `main`.
2. Add or amend the governing **ADRs** (accepted only after human sign-off).
3. Add the slice's **eval cases** first; a person authors the ground-truth labels. Cases
   run **red**.
4. Build the production code for the slice; make its tier gate green.
5. CI builds the image once, deploys it to an **ephemeral environment** for the branch,
   and runs unit + functional tests, the slice's eval tier, and the invariant suite.
6. **Merge gate:** the slice's tier passes; the invariant suite passes; the build deploys.
7. Merge to `main`; tag `slice-NN`. The ephemeral environment is torn down.

`main` is always green and always deployable.

## 3. Gates are eval tiers, not opinions

Three tiers are the merge gates. They are described in full in the
[eval specification](../evals/README.md):

- **Correctness** — fixture repositories with deterministic oracles.
- **Robustness** — pinned real repositories with per-invariant thresholds.
- **Adversarial** — an owned suite whose payloads are stored encoded; mitigations must
  fail closed.

CI treats a tier two ways at once (a *ratchet* and a *target*): the ratchet says "do not
get worse" and fails the run; the target says where the control is meant to be and is
reported every run. This is how CI stays honest while early slices are legitimately red.

## 4. Human-authored ground truth

The agent scaffolds the harness, the fixtures and the **computable** oracles (values
derivable from a fixture or manifest, or hand-computed — never by calling the
implementation). Every **judgment** label is authored by a person; until then the case
carries `labelled_by: null` and is not counted. The agent never authors the answer it is
later graded against.

## 5. Slices are the argument

Each slice is a vertical: schema, code, UI and evals for one capability, landing together
as that slice's gates go green. The branches are the argument and the proof — a reader can
replay them and watch the red evals turn green one capability at a time.

## 6. The learning layer, added last

After the clean slices land, a final layer of tests is added per slice that narrates the
real, non-linear path — the defects we hit, the decisions we revisited. The spine of the
repository is the clean target; the learning layer is the honest story of getting there.
