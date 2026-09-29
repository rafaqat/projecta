---
id: ADR-0026
title: "Embeddings live in a narrow table, and vector search stays exact"
status: proposed
date: 2026-09-29
supersedes: []
superseded_by: []
related: [ADR-0019, ADR-0022]
---

# ADR-0026: Embeddings live in a narrow table, and vector search stays exact

## Context

`chunks.embedding` has no index. The follow-up standing against it was "add an ANN index, measured
against the eval suite", on the assumption that the cost of vector search is the distance arithmetic
and that an approximate index is the way to reduce it.

Measured on the developer stack — Postgres 17.11, pgvector 0.8.6, 14,767 chunks across six commits,
the largest commit holding 4,447 — the assumption is wrong.

The query in `searchVector` filters `where c.commit_id = :commit`, and `chunks` already carries an
index on `commit_id`. So the scan is not over the table; the planner uses that index to reach one
commit's rows in 1.4 ms. The remaining time is spent reading the embeddings:

```
Bitmap Index Scan on chunks_commit_id_index   1.435 ms   rows=4447
Bitmap Heap Scan on chunks c               217.944 ms   Heap Blocks: exact=919
                                                        Buffers: shared hit=53472
Execution Time                             221.344 ms
```

919 heap blocks, and 53,472 buffer accesses — twelve per row. That ratio is the finding.
`pg_attribute.attstorage` for `embedding` is `e`, EXTERNAL: pgvector marks vector columns so they are
stored out of line and uncompressed. Every one of the 4,447 embeddings is therefore a TOAST fetch —
a TOAST index descent plus a chunk read, about twelve buffer touches each. The table carries 18 MB of
heap and 34 MB of TOAST.

So the 221 ms is detoasting, not arithmetic, and an ANN index addresses it only incidentally, by
avoiding reading most of the rows at all. It would also cost two things this repository is built on.
Retrieval feeds an eval suite with golden labels, frozen adversarial cases and seeded generators, and
the query's `order by` carries a deliberate `path, start_line, id` tie-break for determinism; HNSW is
not guaranteed to return the same set across index rebuilds. And a filtered ANN query can return
fewer rows than its `limit`, because pgvector traverses the graph and filters afterwards, which is
silent under-return — the failure mode this repository keeps finding and keeps trying to make loud.

## Decision

Move the vector to a narrow table and keep search exact.

```sql
CREATE TABLE chunk_embeddings (
  chunk_id  uuid PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  commit_id uuid NOT NULL,
  embedding halfvec(768) NOT NULL
);
ALTER TABLE chunk_embeddings ALTER COLUMN embedding SET STORAGE MAIN;
CREATE INDEX chunk_embeddings_commit_id ON chunk_embeddings (commit_id);
```

`SET STORAGE MAIN` keeps the value inline. A `halfvec(768)` is 1,544 bytes, which fits a page
alongside two uuids where it did not fit beside `text`, `search_text` and a generated `tsvector`. The
row becomes the vector, so scanning a commit's vectors reads the vectors and nothing else.

`searchVector` selects the top k from that table and joins back to `chunks` for the text of the k
winners only. RLS follows the same pattern as the other index tables: `ENABLE` plus `FORCE ROW LEVEL
SECURITY` with the workspace policy, so `commit_id` alone is never the boundary.

No ANN index. Search stays exact, which keeps retrieval deterministic and leaves the eval suite
measuring retrieval rather than measuring an index's recall.

## Options considered

Timings are the same query shape against the same 4,447-row commit on the same stack.

| Option | Time | Outcome | Reason |
|---|---|---|---|
| Leave it as it is | 221 ms | Rejected | A fifth of a second per turn spent detoasting, growing linearly with a commit's chunk count |
| HNSW index on `chunks.embedding` | — | Rejected | Addresses the arithmetic, and the cost is not the arithmetic. Costs determinism, which the golden labels depend on, and risks silent under-return on a filtered query |
| Narrow table, `SET STORAGE MAIN`, exact search | **6.2 ms** | **Chosen** | 36× faster than today with the text join included, exactness kept, no new failure mode. 23 MB heap and 8 KB of TOAST, against 18 MB + 34 MB |
| Narrow table *and* an HNSW index on it | 3.2 ms | Rejected for now | Twice as fast again, for approximation and non-determinism. Not a trade worth making to save 3 ms; revisit if a commit's chunk count grows an order of magnitude |
| `ALTER TABLE chunks ALTER COLUMN embedding SET STORAGE MAIN` in place | Not measured | Rejected | The row is already wide with `text` and `search_text`, so the vector would not fit inline beside them and Postgres would push it out of line regardless. The narrow table is what makes inline storage possible |

## Consequences

- Vector search over the largest current commit costs 6 ms rather than 221 ms, and the ingest writes
  one more row per chunk.
- Retrieval stays deterministic, so an eval result that moves means retrieval moved.
- `chunks.embedding` is dropped, which is the one destructive step; the column's data is copied in the
  same forward-only migration and the copy is verified by row count before the drop.
- `embedding_key` stays on `chunks`, being a provenance field rather than a vector.
- The honeytokens table has the same shape and the same TOAST cost at a far smaller row count, so it
  is deliberately left alone rather than changed without a measurement to justify it.
- A commit's vectors are now contiguous, so the scan is sequential. The improvement should grow with
  chunk count rather than shrink.

## Enforcement

- A migration test asserts `chunk_embeddings` has one row per chunk that had an embedding, and that
  `pg_attribute.attstorage` for its `embedding` column is `m`. That second assertion is the point of
  the change and is otherwise invisible — a future `ALTER` or a table rebuild could silently return it
  to EXTERNAL and only a timing regression would show it.
- The retrieval suite runs unchanged. Exact search means its expected values do not move, so any
  movement is a defect rather than a tolerance.
- RLS tests cover `chunk_embeddings` with two real workspaces, as for every other index table.

## Revisit when

A single commit's chunk count reaches roughly 100,000, where an exact scan would cost about 150 ms
again on this hardware and an approximate index starts to pay for what it costs; or pgvector gains an
index that can take `commit_id` as a prefix, which would remove the filtered under-return risk and
make the comparison a straight one about recall.
