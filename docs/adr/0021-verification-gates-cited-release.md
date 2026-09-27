---
id: ADR-0021
title: "A cited sentence is released only after verification; a rejection withholds it"
status: accepted
date: 2026-09-27
supersedes: []
superseded_by: []
related: [ADR-0013, ADR-0017]
---

# ADR-0021: A cited sentence is released only after verification; a rejection withholds it

## Context

ADR-0013 states that a sentence citing a repository span "is verified against that span". The
implementation of `app/assistant/evidence_gate.ts` released a cited sentence and its citation first and
called the verifier afterwards, treating the verifier's result as an advisory annotation. Nothing the
verifier decided could withhold or retract the sentence. An adversarial review (2026-09-26) reproduced
the gap: a synthetic answer citing a real, hydrated evidence span but asserting `` `inventedFunction`
validates all credentials. `` — an entity absent from the repository — was released in full, while the
same turn's annotation said `unverified: not in repository`. A valid citation was sufficient to release
a fabricated or injected claim.

A second observation from the same review is that the verifier's `verified` status confirms that a
named entity exists and its body is covered by the cited span; it does not, and cannot without a
semantic oracle, confirm that an arbitrary behavioural assertion about that entity is true (a claim that
a function "returns true" when it returns false is still labelled `verified` because the function
exists and is on screen). That is a property of what verification can decide, not a defect this ADR
removes.

## Decision

For a cited sentence the evidence gate calls the verifier **before** releasing, and a hard rejection
withholds the sentence instead of releasing it with an annotation. A hard rejection is narrowly the
**absent-entity** case: the verifier reports `unverified` with "not in repository", i.e. the cited
name does not exist in the indexed commit — a fabricated or injected citation target. A sentence that
cites a real declaration but describes it beyond the cited lines ("described without its code") is
`unverified` too, but it names real code and stays **released with its annotation**, exactly as
ADR-0013 always allowed; only absence withholds. Other statuses (`verified`, `not_checkable`,
`dependency`) release as before. The verification event is still recorded for the decision record, and
the citation is still emitted so none is dropped; only the fabricated-entity sentence is held. The
withhold is marked in place with reason `unverified_citation` and the turn's `withheldBy` is set to
`unverified_citation`.

This aligns the code with ADR-0013's stated intent. It does not change the meaning of `verified`:
verification is provenance plus entity/coverage resolution, not behavioural entailment. Prose that
`verified` cannot substantiate is a product limitation to be narrowed by better verification, not by
relaxing the gate.

## Options considered

| Option | Outcome | Reason |
|---|---|---|
| Keep release-then-annotate | Rejected | A citation alone releases a fabricated/injected claim; contradicts ADR-0013. |
| Verify before release; a rejection withholds | Chosen | Verifier is synchronous, so no buffering/latency cost; restores the ADR-0013 guarantee. |
| Also downgrade `verified` for behavioural claims | Deferred | Needs behavioural entailment (an oracle the system does not have); risks withholding legitimate answers and shifting frozen eval baselines. Recorded as a limitation. |

## Consequences

- A cited sentence whose named entity is absent from the commit is withheld, not shown. Sentences that
  cite real code — whether fully covered (`verified`) or described beyond the cited lines
  (`unverified`/"described without its code") — are unaffected and still release, so the correctness,
  adversarial, robustness and image-e2e suites are unchanged by this decision.
- The withhold is observable: the turn emits the `answer.claim_withheld` security event (a counter and a
  log record; reason only, never the withheld prose), so a run of unsupported cited claims is alertable.
- `verified` continues to mean "the cited entity exists and its body is on screen", not "this behavioural
  claim is true". Consumers must not read it as the latter.

## Enforcement

`tests/unit/assistant/evidence_gate_verification.spec.ts`: a cited sentence naming a nonexistent entity
is withheld (`released` empty, `withheldBy === 'unverified_citation'`); a cited sentence naming real,
covered code is still released. The eval suites (`evals/correctness_run`, `adversarial_run`,
`robustness_run`) guard against over-withholding legitimate answers.

## Revisit when

A verifier capable of behavioural entailment (not just entity/coverage resolution) is available, or the
`answer.claim_withheld` rate shows the gate withholding legitimate cited prose.
