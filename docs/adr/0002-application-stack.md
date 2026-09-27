---
id: ADR-0002
title: "Application stack: AdonisJS v7 + Inertia/React on Postgres/pgvector, one image, Node 24 running TypeScript directly"
status: accepted
date: 2026-09-21
supersedes: []
superseded_by: []
related: ["ADR-0001"]
---

# ADR-0002: Application stack

_Accepted by the owner, 2026-09-21._

## Context

Slice 1 introduces routing, identity, an ORM with transaction-scoped row-level-security context,
and authorisation policies. The walking skeleton (Slice 0) is a bare Node HTTP server; it proved
the pipeline but is not a place to grow an application. The application stack is AdonisJS v7 +
Inertia/React on Postgres, built up slice by slice — so the framework choice is really "a
batteries-included, convention-driven stack" versus "assemble and wire it by hand".

## Decision

1. **AdonisJS v7** for the HTTP server, dependency container, **Lucid** ORM (its transaction API is
   how the row-level-security scope context is set per request, ADR-0003), **Bouncer** for
   authorisation policies, and its Japa test runner.
2. **Inertia + React** for the UI, server-driven, no separate API client.
3. **Postgres with pgvector** as the single datastore (already stood up in Slice 0); retrieval in
   later slices uses pgvector.
4. **Node 24 runs the TypeScript directly** (native type-stripping) — consistent with the harness
   and skeleton; the production image is built once and promoted (ADR-0001, the Dockerfile exists).

## Options considered

| Option | Outcome | Reason |
|---|---|---|
| AdonisJS v7 + Inertia + Lucid (this ADR) | **Proposed** | Matches the working original; Lucid transactions carry the RLS scope; Bouncer gives per-route policies |
| Keep the bare Node skeleton and hand-roll routing/ORM/authz | Rejected | Re-implements what the original already has; no transaction-scoped RLS story |
| A different framework (Nest, Express + Prisma) | Rejected | A larger departure from the AdonisJS conventions the code is built on |

## Consequences

- Slice 1 brings the AdonisJS boot files across (adonisrc, providers, config, kernel) in place of
  `src/server.ts`; `/healthz` moves to a controller. The migration runner becomes `node ace
  migration:run` (Lucid), still forward-only.
- The CI `skeleton` job evolves into the app's boot+health check; the Postgres service stays.
- pgvector is available for Slice 2+ retrieval with no further infrastructure.

## Enforcement

- The Slice-1 CI boots the AdonisJS app against the Postgres service and health-checks it (the
  skeleton job, retargeted).
- An import-boundary lint (added when the LLM gateway lands) keeps provider access to one module.

## Revisit when

- A hard requirement appears that AdonisJS cannot meet (none is known); revisit with a superseding ADR.
