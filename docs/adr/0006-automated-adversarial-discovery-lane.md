---
id: ADR-0006
title: "Automated adversarial discovery lane (PyRIT)"
status: accepted
date: 2026-09-25
supersedes: []
superseded_by: []
related: [ADR-0001]
---

# ADR-0006: Automated adversarial discovery lane (PyRIT)

## Context

projectA has two red-team lanes today (design §12): the deterministic structural runner
(`app/redteam/runner.ts`) that replays **frozen** cases against a scripted model in CI, and its
live variant (`app/redteam/live.ts`) that replays the same frozen cases through the **real** turn
pipeline (`answerTurn`, behind the gateway) and measures containment with oracles
(`SCRIPTED_ORACLES`, `passes()`). Attack material is authored by hand — seeds
(`evals/redteam/seeds.json`), threats (`evals/redteam/threats.yaml`), and deterministic converter
variants (`node ace redteam:generate` → `generated/variants.json`, base64). PyRIT is enabled
offline for converter variants (`evals/redteam/tools/`, pinned in `uv.lock`).

What is missing is **discovery**: an automated way to find *new* attacks against the running
assistant instead of only regressing known ones. Today the eval can only test attacks a human
already imagined.

## Decision

Add a third lane — an **automated adversarial discovery lane**, offline/UAT only — that uses PyRIT
to *generate* candidate attacks, executes them through the **existing** live lane (`runLive` →
`answerTurn`), scores each against projectA's containment signals, and produces a scorecard plus
review-gated candidate cases.

**Architecture A** (chosen): PyRIT is an offline attack *generator* (Python, in
`evals/redteam/tools/`, extending the converter generator); the existing TypeScript live lane is
the executor and scorer. PyRIT never calls the assistant directly and introduces no new inference
path or provider-SDK boundary. **Converters-first**: the initial generator expands the frozen
seeds through PyRIT converters and combinations (deterministic, key-free); an adaptive attacker
LLM is a later amendment (it needs a model + UAT credentials).

The lane is **discovery only**. Its output is candidate attacks + a scorecard, written base64 into
`generated/` (staging), **never promoted automatically**. A human reviews breaches and promotes
real findings into the frozen lane-1 set (`cases/regression.json`); only then do they enter the
deterministic CI eval.

## Options considered

| Option | Outcome | Reason |
|---|---|---|
| **A**: PyRIT generates, existing live lane executes + scores | **accepted** | reuses `runLive` + oracles + the gateway/attribution path; PyRIT stays in its sanctioned offline role; no new inference path |
| B: PyRIT / Azure AI Red Teaming Agent drives a live target directly | deferred | adaptive multi-turn attacker, but needs an attacker model + Azure creds + a new authenticated target path + duplicated scoring |
| Do nothing (hand-authored attacks only) | rejected | the eval can only ever test attacks a human already imagined |

## Consequences

- New offline tooling: a PyRIT generator (Python, `evals/redteam/tools/`), a TS bridge that parses
  staged output into `RedteamCase[]`, a scorecard/triage reporter, and an entry point
  (`node ace redteam:discover` / `make redteam-discover`).
- The lane runs offline/UAT (real stack + model + spend); it is **never** in CI. The deterministic
  adversarial tier is unchanged and continues to gate on the promoted, frozen cases.
- **INV-01 preserved**: the only model call is the assistant's own, through the existing
  gateway/attribution path in `answerTurn`; PyRIT adds no provider-SDK boundary.
- The **R-06/R-08 boundary is explicit and mechanical**: generated attacks land base64 in
  `generated/`; promotion into `cases/regression.json` is a human step. The lane scaffolds
  candidates with `labelled_by: null` and never writes trap expectations.
- Dependency: `pyrit` + `azure-ai-evaluation[redteam]` are already declared and pinned
  (`evals/redteam/tools/uv.lock`); no new runtime dependency in the app.

## Enforcement

- The discovery entry point is offline-only and absent from every CI workflow; a test asserts CI
  does not invoke `redteam:discover`.
- The bridge parses staged output with a Zod contract and rejects malformed/oversized input (no
  path traversal, capped counts) before any case runs.
- Promotion stays manual: the reporter writes candidates with `labelled_by: null`; changes to
  `cases/regression.json` remain human-reviewed (R-06/R-08).
- Scoring reuses the existing oracles (`passes`, `SCRIPTED_ORACLES`) and the zero-tolerance
  counters (`injection_fail_closed`, `no_plaintext_payload`, honeytoken/canary leak).

## Revisit when

- The discovery lane stops finding new breaches across several runs (converters exhausted) —
  consider the Architecture B amendment (adaptive attacker LLM / Azure Red Teaming Agent).
- The lane's runtime or spend becomes material — gate it behind an explicit budget.
