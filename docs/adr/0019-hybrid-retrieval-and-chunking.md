---
id: ADR-0019
title: "Retrieval fuses vectors and BM25 over whole-declaration chunks, ranked on what the model is shown"
status: accepted
date: 2026-09-26
supersedes: []
superseded_by: []
related: [ADR-0002, ADR-0013]
---

# ADR-0019: Retrieval fuses vectors and BM25 over whole-declaration chunks, ranked on what the model is shown

## Context

Grounding is only as good as retrieval: if the right code is not in evidence, the evidence gate can
only withhold. Two failure modes drive the design. First, a question can name a concept ("where do we
retry a failed upload") or an exact identifier ("what calls getUserById"), and no single retriever is
best at both. Second, if a chunk is a blind fixed-width window, a cited span can miss its own signature
or closing brace, and short fragments can outrank the function that actually answers.

## Decision

A chunk is a whole function or declaration, cut on the syntax tree, up to a weighted-character budget,
with a container never re-chunking its children and an over-budget statement split along its inner
statements; a cited span ends where its syntax does. Retrieval runs a vector search (pgvector, cosine)
for concept-to-code and a BM25 search over a lexical view for name-to-code, and fuses the two by
reciprocal rank fusion, then applies diversity caps and an exact-match rerank so a chunk carrying the
question's exact identifiers, routes or file names outranks one that only matches semantically. What
ranks a chunk is the text the model is shown, so nothing can steer retrieval through content the model
never sees. A trigram pass is a separate did-you-mean at question routing, never part of the fusion.

## Options considered

| Option | Outcome | Reason |
|---|---|---|
| Vector search alone | rejected | misses exact identifiers, constants and paths a question names |
| Fixed-width chunks | rejected | cited spans lose their signature or brace; short fragments outrank functions |
| Whole-declaration chunks, vector plus BM25 fused, ranked on shown text (chosen) | accepted | concept and exact recall together, over units that cite cleanly, unsteerable |

## Consequences

- A cited span is a whole, syntactically complete declaration, not a window into one.
- Concept questions and exact-identifier questions are both served, and fused deterministically.
- Ranking uses only what the model sees, so hidden content cannot promote a decoy into evidence.
- Retrieval quality is a measured property, not an assumed one.

## Enforcement

The correctness and robustness eval tiers measure recall and mean reciprocal rank on pinned repositories
and score against golden fixtures. An ablation removing the exact-match rerank or the diversity caps
changes the ranking measurably, proving each is load-bearing. A rank-poisoning fixture cannot promote a
chunk through text the model is not shown.

## Revisit when

The retrieval tier regresses on a pinned corpus, or a new language profile needs its own chunk shape.
