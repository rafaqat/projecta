---
id: ADR-0015
title: "The model keeps no memory between turns; the index is the only durable knowledge"
status: accepted
date: 2026-09-26
supersedes: []
superseded_by: []
related: [ADR-0013, ADR-0014]
---

# ADR-0015: The model keeps no memory between turns; the index is the only durable knowledge

## Context

A tempting way to make an assistant "learn" is to let it accumulate memory across turns: store past
answers, strategies, or reasoning and feed them back into later prompts. For a grounded code assistant
this is a hazard, not a feature. Accumulated model memory is unattested content injected into future
answers, so a single poisoned or drifted entry contaminates everything downstream, and the memory
outlives the code it described, so it goes wrong silently when the repository changes.

## Decision

The model holds no state between turns. The only durable knowledge is the index, which is rebuilt from
the code and always reflects the current commit; every turn retrieves from it afresh. There is no store
of model-authored memories, strategies, or reasoning that a later turn reads back. If reusable memory
is ever added, it will be limited to answers a person has verified, bound to the commit and the cited
blob hashes so it expires the moment that code changes, and it will pass the same evidence gate as any
other answer rather than being trusted because it was stored. That remains out of scope here.

## Options considered

| Option | Outcome | Reason |
|---|---|---|
| Model-authored memory of past turns | rejected | unattested content; one bad entry poisons downstream answers |
| Cache raw model reasoning or strategies | rejected | outlives the code it described; wrong silently after a change |
| No model memory; the index is the only durable knowledge (chosen) | accepted | knowledge that cannot drift because it is rebuilt from the code |

## Consequences

- An answer cannot be poisoned by something a previous turn "remembered".
- There is no cache to invalidate on a commit change, because there is nothing model-authored to store.
- Repeated identical questions are re-derived; the cost is latency, not correctness.
- Any future reusable memory is a separate, explicitly gated decision, not a default.

## Enforcement

A turn is tested to read only from the index and the request, with no cross-turn model state. A
poisoning fixture cannot create a durable entry that a later turn reads.

## Revisit when

Real users repeat questions often enough that verified, commit-bound, gate-checked reusable answers are
worth their review workflow.
