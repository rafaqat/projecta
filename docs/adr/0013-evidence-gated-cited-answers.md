---
id: ADR-0013
title: "An answer ships only the sentences the evidence supports; everything else is withheld with a reason"
status: accepted
date: 2026-09-26
supersedes: []
superseded_by: []
related: [ADR-0001, ADR-0012]
---

# ADR-0013: An answer ships only the sentences the evidence supports; everything else is withheld with a reason

## Context

A code assistant that answers from a model will, unguarded, state things the repository does not
support: a function that does not exist, a behaviour it invented, a name it half-remembers. Retrieval
narrows what the model sees but does not stop it from filling gaps. The product's whole claim is that
an answer is grounded in the code, so groundedness has to be enforced on the output, not hoped for in
the prompt.

## Decision

The model's answer is streamed through an evidence gate (`app/assistant/evidence_gate.ts`) that
releases text sentence by sentence and only when it is supported. A sentence that cites a repository
span is verified against that span; an uncited sentence that names a declaration is checked against the
index (verified, `not_checkable`, or withheld); a calibrated budget of uncited connective prose is
allowed, and anything past it renders its own notice rather than reaching the reader. When there is no
sufficient evidence the turn returns a template, not a guess. Withheld text is marked where it was,
with how much and why, so the reader sees that something was held rather than silently dropped.

## Options considered

| Option | Outcome | Reason |
|---|---|---|
| Prompt the model to "only use the sources" | rejected | a prompt is a request, not a control; it cannot be tested to hold |
| Post-hoc fact-check the whole answer | rejected | too coarse and too late; a streamed answer needs per-sentence gating |
| Stream through a gate that releases only supported sentences (chosen) | accepted | groundedness becomes a mechanical property, provable by ablation |

## Consequences

- Every shipped sentence is either cited-and-verified or within a measured connective budget.
- The gate is fail-closed: uncertainty withholds rather than emits.
- Answer quality depends on retrieval and on the connective budget's calibration, which the evals gate.
- A refusal is legible: the reader is told what was withheld and what question would surface it.

## Enforcement

The correctness eval tier measures citation precision and recall and answerable accuracy. An ablation
that disables the gate leaks an unsupported claim the gate otherwise withholds, proving the gate is
load-bearing. A red-team case in which the model reflects an injected instruction is withheld.

## Revisit when

The connective budget regresses answer quality on the correctness tier, or a new evidence origin
(for example a verified reusable answer) needs its own gate treatment.
