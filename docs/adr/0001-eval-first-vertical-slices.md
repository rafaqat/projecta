---
id: ADR-0001
title: "Build by eval-first, testable vertical slices, with human-authored ground truth"
status: accepted
date: 2026-09-21
supersedes: []
superseded_by: []
related: []
---

# ADR-0001: Build by eval-first, testable vertical slices

## Context

This repository is built method-first: the target is defined before it is implemented, then
earned. Rather than retrofit evaluations and revisit decisions after the fact — a path where the
git history records the detour more than the destination — the evals and the architecture
decisions come first, and each vertical slice turns them green.

Two failure modes motivate the decision. First, evaluations written *after* the code tend
to encode what the code already does, not what it should do. Second, a broad build with no
per-capability gate makes it impossible to say which part is trustworthy at any moment.

## Decision

1. **Eval-first.** The three evaluation tiers (correctness, robustness, adversarial) and
   their target thresholds are defined before the code that must satisfy them. Early slices
   legitimately report those tiers red.

2. **Testable vertical slices.** Each milestone is one branch, `slice/NN-<name>`, that cuts
   through the whole stack and delivers a user-visible capability. A branch merges only when
   it builds, its tests and its eval tier pass, the invariant suite passes, and it deploys
   to an ephemeral environment.

3. **Decisions precede code.** An architecture-shaping decision is an ADR, accepted by a
   human before implementation. Accepted ADRs are immutable.

4. **Human-authored ground truth.** The agent scaffolds the harness, fixtures and
   computable oracles; a person authors every judgment label. A case carries
   `labelled_by: null` until a human completes it, and uncompleted cases are not counted.
   Oracles never call the implementation under test.

5. **CI is a ratchet and a target.** Each tier fails the run if it regresses (ratchet) and
   reports where the control is meant to be (target). This keeps CI honest while early
   slices are red.

## Options considered

| Option | Outcome | Reason |
|---|---|---|
| Eval-first, vertical slices, human-labelled ground truth (this ADR) | **Accepted** | Target precedes code; every capability has a gate; ground truth is trustworthy |
| Build first, add evals after | Rejected | Evals encode current behaviour, not intended behaviour |
| Horizontal layers (all models, then all services, then all UI) | Rejected | No layer is independently demonstrable or deployable |
| Agent authors golden labels for speed | Rejected | The agent would grade itself against its own answers |

## Consequences

- The git history reads as intent-then-capability: decisions and target evals appear before
  the code that satisfies them.
- Early slices show red eval tiers by design; this is reported, not hidden.
- Some slices block on human labelling before they can go green. That is accepted.

## Enforcement

- CI runs the eval harness on every branch and reports each tier as a ratchet and a target.
- A structure check fails the build if an accepted ADR is edited, or if a golden case is
  counted while `labelled_by` is null.
- The merge gate for a slice requires its tier green, the invariant suite green, and a
  successful ephemeral deploy.

## Revisit when

- A tier's target is met with margin across three consecutive slices and no longer
  discriminates (tighten it, in a superseding ADR).
