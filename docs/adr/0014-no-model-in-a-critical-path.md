---
id: ADR-0014
title: "No model output decides access, tenancy, or what the index returns"
status: accepted
date: 2026-09-26
supersedes: []
superseded_by: []
related: [ADR-0003, ADR-0012, ADR-0013]
---

# ADR-0014: No model output decides access, tenancy, or what the index returns

## Context

A model is non-deterministic and steerable by its input, which is exactly the property an attacker
exploits. Any decision that gates security or correctness must therefore be made by code whose
behaviour is fixed and testable, not by a model whose behaviour a crafted question can move. The
temptation is to let the model "decide" routing, filtering, or whether a name exists, because it reads
as convenient; the cost is that the decision inherits the model's steerability.

## Decision

No model output sits in a critical decision path. Authorisation and tenancy are enforced in the
database and the resource guard (row-level security, repository ACLs). Retrieval, ranking, symbol
resolution, dependency and clone facts are deterministic functions the turn runs before the model.
Whether a cited name exists is decided by the index, not by the model's assertion. The model's role is
confined to drafting prose from evidence it is given, and that prose is then gated (ADR-0013). Where a
model is used for a soft classification, its failure degrades to a safe default rather than hardening a
refusal or widening access.

## Options considered

| Option | Outcome | Reason |
|---|---|---|
| Let the model route, filter or judge existence | rejected | a crafted question steers the decision; not testable, not safe |
| Model decisions with a human check | rejected | does not scale to every turn and still trusts a steerable output |
| Deterministic code for every gating decision; model only drafts gated prose (chosen) | accepted | security and correctness decisions are fixed and provable |

## Consequences

- Tenancy, access, retrieval and verification are testable in isolation, without a model in the loop.
- A prompt injection cannot change who can read what, or what the index reports.
- Soft classifiers (for example scope) are advisory: their outage degrades to a safe default.
- Some behaviour that a model could do "for free" is instead written as deterministic code.

## Enforcement

Tenancy and access tests run with no model. A soft classifier's timeout, error or off-enum output is
tested to degrade to the safe default, never to a refusal or a widened scope. Retrieval and
verification are scored by the eval tiers against fixtures, not against a model.

## Revisit when

A decision genuinely cannot be made deterministically, in which case it is designed as advisory with a
safe default and a human check, and recorded as its own decision.
