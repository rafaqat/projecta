---
id: ADR-0003
title: "Authorisation and identity: OIDC login, repository ACLs, workspace row-level security that aborts when unset, and turn-local handles"
status: accepted
date: 2026-09-21
supersedes: []
superseded_by: []
related: ["ADR-0001", "ADR-0002"]
---

# ADR-0003: Authorisation and identity

_Accepted by the owner, 2026-09-21._

## Context

Slice 1 makes the system multi-tenant: people log in, and a workspace's data is invisible to
everyone outside it. Tenancy that relies only on application `where` clauses fails the moment one
query forgets the clause. This enforces isolation in the database itself, with row-level
security, so a forgotten clause cannot leak data.

## Decision

1. **Identity via OIDC.** A single-tenant OIDC login (a mock provider locally, a real one in the
   cloud), immutable identity keys, and a session lifecycle. Authentication failures deny.

2. **Repository ACLs.** A repository is `workspace`-visible (any workspace member may view) or
   `restricted` (explicit repository membership required). Bouncer policies (ADR-0002) express this,
   and **every resource route declares a policy** — enforced by a route-coverage test.

3. **Workspace row-level security that aborts when unset.** Every tenant table has a Postgres RLS
   policy keyed to a scope function. A request runs inside a Lucid transaction that sets the scope
   (`user_id`, `workspace_id`) with `SET LOCAL`; the scope function **raises** when the setting is
   absent or names a workspace the user is not a member of. A query that forgets to enter scope
   therefore *aborts*, rather than silently returning another tenant's rows.

4. **No bare identifiers to the model or over the wire.** API routes and model-facing identifiers
   are **turn-local handles**, never a bare database id or commit SHA — closing IDOR and keeping
   later model-facing surfaces from leaking durable ids.

## Options considered

| Option | Outcome | Reason |
|---|---|---|
| DB-enforced RLS that aborts when unset + ACLs + handles (this ADR) | **Proposed** | Isolation holds even when a query forgets the scope; matches the original |
| Application-only `where workspace_id = ?` | Rejected | One forgotten clause leaks a tenant; no fail-closed guarantee |
| Bare ids in routes with authorisation checks | Rejected | IDOR surface; a missed check is a cross-tenant read |

## Consequences

- Every tenant-table read goes through the scope helper; a new table without an RLS policy is a bug
  the ablation test catches.
- Local development and tests authenticate through the real OIDC flow (mock provider), not a bypass.
- Turn-local handles mean later slices resolve handles per request rather than accepting ids.

## Enforcement

- **Authz/IDOR matrix** (correctness-tier functional tests, deterministic): member vs non-member vs
  cross-workspace, for `workspace`-visible and `restricted` repositories; a foreign or bare id renders
  nothing.
- **Two-workspace RLS ablation**: with the app scope disabled, a cross-tenant read must fail — the
  test that proves RLS is actually the thing enforcing isolation.
- **Route-coverage test**: every resource route declares a Bouncer policy.

## Revisit when

- A second identity provider or multi-tenant OIDC is required (superseding ADR).
