---
id: ADR-0017
title: "A pinned local classifier flags instruction-shaped text as a signal, never as a gate"
status: accepted
date: 2026-09-26
supersedes: []
superseded_by: []
related: [ADR-0006, ADR-0014]
---

# ADR-0017: A pinned local classifier flags instruction-shaped text as a signal, never as a gate

## Context

Indirect prompt injection hides an instruction inside content the assistant ingests, such as a comment
or a string in the code. Detecting instruction-shaped text is useful, but a detector is imperfect: it
has both false positives and false negatives, so making it a hard gate would either withhold real
answers or give a false sense that injection has been stopped. The real containment is elsewhere
(grounding, the gateway, tenancy); the detector's job is to raise a signal, not to be the wall.

## Decision

A pinned local classifier (`protectai/deberta-v3-base-prompt-injection-v2`) runs at ingest over the
prose extracted from code and at query time over the question, served from the model server by SHA-256
pinned weights (`app/parse/injection.ts`). Its output is an annotation, not a decision: it flags
instruction-shaped chunks and records what it read, and it **fails open** so that a detector outage
never blocks an answer. It scores prose only, never markup or identifiers, so a class list or a JSON
key is not mistaken for an instruction. Containment does not depend on it: grounding, the gateway and
tenancy stand whether or not the detector fires.

## Options considered

| Option | Outcome | Reason |
|---|---|---|
| A rules regex for injection phrases | rejected | brittle; misses paraphrase and obfuscation, over-matches ordinary text |
| Detector as a hard gate that blocks flagged content | rejected | false positives withhold real answers; false negatives give false assurance |
| Pinned local classifier as a fail-open annotation (chosen) | accepted | a useful signal that cannot itself become a denial-of-service or a crutch |

## Consequences

- Flagged chunks are visible as a signal on the repository view, described as a signal, not a verdict.
- A detector outage degrades to no annotation, never to a blocked or withheld answer.
- The model server pins the weights by hash, so the detector is a fixed, recorded configuration.
- Because it reads prose only, template attribute values and JSON keys are not false-flagged.

## Enforcement

The detector's recall and false-positive rate are measured against a labelled corpus, tracked as a
ratchet and a target. A canary case proves the annotation is emitted; an outage is tested to fail open.
The prose-only extraction is covered by an ablation.

## Revisit when

The detector's measured recall or false-positive rate crosses its target enough to justify a new model
or a change in how the signal is used.
