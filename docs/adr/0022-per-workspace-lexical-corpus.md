---
id: ADR-022
title: "A workspace is ranked against its own corpus, not the cluster's"
status: accepted
date: 2026-09-27
supersedes: []
superseded_by: []
related: [ADR-019, ADR-003]
---

# ADR-022: A workspace is ranked against its own corpus, not the cluster's

## Context

Lexical retrieval (ADR-019) scores chunks with BM25 through one index per table, shared by every
workspace: `chunks_search_bm25`, `symbols_name_bm25`, `honeytokens_search_bm25`. Row-level security
restricts which rows a query may _return_, but a BM25 score is not computed from the returned row
alone: inverse document frequency comes from the whole index. Every workspace's rows therefore
contribute to every other workspace's scores.

Measured on this schema, with two workspaces and nothing shared between them:

|                                                         | workspace A's doc 1 ("alpha") | workspace A's doc 2 ("beta") | A's order |
| ------------------------------------------------------- | ----------------------------- | ---------------------------- | --------- |
| A alone in the index                                    | 0.9531                        | 0.9531                       | 1, 2      |
| after workspace B adds 500 documents containing "alpha" | **0.0038**                    | **7.3138**                   | **2, 1**  |

A changed nothing of its own. Two consequences follow, and the second is the more serious:

1. **An inference channel.** A can estimate how often a term occurs in corpora it cannot read, by
   watching the order of its _own_ results. No score has to be exposed for this: ordering carries
   it. Scores are in fact not exposed anywhere — SEC-28 already requires "a boolean, never a score"
   — but the cited evidence is ordered and top-k, so the channel is open through ordering alone.
2. **A tenant's retrieval quality depends on other tenants.** A's "alpha" document became
   effectively unrankable (0.0038). A workspace that indexes a large corpus of common terms pushes
   another workspace's genuinely relevant chunks out of its own top-k. Hybrid fusion (ADR-019) damps
   this, because the vector retriever is unaffected, but it does not remove it.

Upstream names the same property and added a setting to prohibit the combination
(timescale/pg_textsearch#492): "BM25 corpus statistics include all indexed rows. On tables using
row-level security, a user who already knows a term may therefore infer frequency information
influenced by inaccessible rows." The setting `pg_textsearch.allow_rls` defaults to on, so nothing
currently prevents it here.

## Decision

Index the lexical corpus **per workspace**: for each workspace, a partial BM25 index restricted to
its rows, and `searchLexical` names that workspace's index. Corpus statistics are then computed over
one workspace's documents, so no other workspace can influence a score or an order.

`honeytokens_search_bm25` stays global and shared. That index is the cross-workspace sensor by
design (SEC-30): the query deliberately reads `where not (h.workspace_id = :workspace)` to detect a
foreign token reaching the model. Scoping it per workspace would disable the sensor.

## Options considered

| Option                                             | Outcome    | Reason                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One shared BM25 index (status quo)                 | Rejected   | Measured above: another workspace's corpus changes a tenant's own scores by three orders of magnitude and flips its order.                                                                                                                                                                                                                                                             |
| **Partial BM25 index per workspace**               | **Chosen** | Verified on this extension: a partial index reports `total_docs: 2` for a two-document workspace and returns 0.9531/0.9531 with 500 foreign documents present — identical to the baseline. Keeps BM25 ranking.                                                                                                                                                                         |
| Switch lexical retrieval to the `tsvector` backend | Rejected   | It does remove the channel — `ts_rank` uses no corpus statistics, verified invariant (0.075991 with 500 foreign documents, 0.075991 without) — and the code path already exists as the fallback. But it changes retrieval quality, and the eval tiers ratchet against frozen baselines; the decision would be "accept worse lexical ranking", which is not required to close the leak. |
| Hash-partition the tables by workspace             | Rejected   | Statistics become per partition, and a partition holds many workspaces, so the leak is reduced rather than removed.                                                                                                                                                                                                                                                                    |

## Consequences

- One BM25 index per workspace per indexed table. The index count scales with tenants; that is the
  cost of per-tenant statistics.
- They are created by the index step, before a workspace's first chunk is written, from
  `ensureLexicalIndexes`. Not by provisioning: `chunks` and `symbols` arrive in a later vertical
  slice than `workspaces`, so provisioning cannot name them. Nothing drops them, because the
  application has no workspace-deletion path; a deletion path, if one is added, must drop the two
  indexes `lexicalIndexNames` gives for that workspace.
- `searchLexical` and `symbolNameHits` name the workspace's index. `to_bm25query(terms, '<index>')`
  takes the index name as a literal, so the name is interpolated rather than bound: it is derived in
  `lexicalIndexNames` from a validated UUID, in that one place, and nowhere else.
- **No backfill is possible.** The migration only drops the shared `chunks_search_bm25` and
  `symbols_name_bm25`. It cannot create the per-workspace ones for workspaces that already exist:
  migrations run as `app`, which has no BYPASSRLS, and `boot_guards` refuses to start with a role
  that does, so enumerating every workspace is unavailable to the application by design. A workspace
  indexed before this change therefore has no corpus of its own until its next ingest, and its
  lexical query raises `42704 undefined_object`, which `isLexicalIndexFault` treats as a fault: the
  query is answered from the tsvector column, which holds no corpus statistics and so cannot leak.
  Ranking is weaker for such a workspace until it is ingested again, and every one of those queries
  is counted (`app.lexical.faults`) and logged.
- Scores are not comparable across workspaces any more. Nothing compares them today, and after this
  nothing may.

## Enforcement

`tests/functional/tenancy/lexical_corpus.spec.ts`: seed two workspaces, record workspace A's ranking
of its own documents, index documents into workspace B, and assert A's scores and order are
unchanged. It is the measurement in the Context table as a spec, so the property is checked rather
than asserted, and it fails on a shared index (measured: 0.693147 to 0.038912, with the order
inverted). It also asserts that the BM25 index answered, by checking the lexical fault count did not
move, so a fallback cannot make it pass. The existing cross-tenant citation and honeytoken suites
continue to cover what RLS already prevents.

## Revisit when

The extension can compute corpus statistics over a filtered subset of one index, which would make
per-workspace indexes unnecessary; or when a measurement shows the index count per cluster has
become the binding cost.
