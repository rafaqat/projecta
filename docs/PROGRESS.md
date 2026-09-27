# Progress — the full roadmap as a checklist

Legend: ✅ done · 🔄 in progress · ⏳ blocked on a human gate (ADR acceptance or labels) · ☐ not started.
Each slice is one branch → PR → `main`, tagged `slice-NN`. See [roadmap.md](roadmap.md) and
[methodology.md](methodology.md).

## Phase 0 — Constitution  ✅ (merged, tag `slice-00`)
- [x] Licence, README, methodology, roadmap
- [x] ADR-0001 (eval-first, testable vertical slices) — accepted
- [x] Eval specification + the three tiers, present and **red**
- [x] Eval harness (ratchet + target), unit-tested with a canary
- [x] Walking skeleton — boot, Postgres/pgvector, forward-only migration, `/healthz`
- [x] CI: constitution · typecheck · test · evals (red) · skeleton (real DB)

## Slice 1 — Identity & tenancy  🔄 `slice/01-identity`
- [x] ADR-0002 (application stack: AdonisJS v7 + Inertia + Lucid) — **accepted** ✅
- [x] ADR-0003 (authorisation & identity: OIDC, ACLs, workspace RLS, turn-local handles) — **accepted** ✅
- [x] ✅ Owner accepted ADR-0002 and ADR-0003 (2026-09-21) — building
- [x] **RLS foundation (SQL): scope functions that abort when unset; repositories under FORCE RLS**
- [x] **Two-workspace RLS ablation, executed in CI** (member-isolated · unset-scope aborts · cross-workspace refused)
- [ ] Bring AdonisJS v7 across from the original (routing, Lucid, Bouncer, test runner) — wraps the RLS core
- [ ] OIDC login (mock provider locally), session lifecycle
- [ ] Repository ACLs (workspace-visible vs restricted); turn-local handles
- [ ] Gate: full authz/IDOR matrix (once ACLs land on the app layer)

## Slice 2 — Ingest  ☐ `slice/02-ingest`
- [ ] Hardened ingestion; parse/chunk/index a repository; browse it
- [ ] Gate: parse/chunk/index fixtures (correctness) + ingest pinned real repos (robustness)
- [ ] ⏳ Owner labels: robustness `pinned_sha` + the fixture answers

## Slice 3 — Cited answers  ☐ `slice/03-answers`  → **Gate G1**
- [ ] Ask a question; grounded answer with verified citations; evidence gate
- [ ] Gate: citation precision/recall (correctness) + robustness thresholds
- [ ] ⏳ Owner labels: correctness citation/enumeration goldens

## Slice 4 — Audit, attribution, cost  ☐ `slice/04-audit`  → **Gate G2**
- [ ] Every token/span attributed to a person; signed gateway; cost reconciled
- [ ] Gate: adversarial suite fails closed + attribution coverage
- [ ] ⏳ Owner labels/authors: adversarial payloads (encoded)

## Slice 5 — Structure & clones  ☐ `slice/05-structure`
- [ ] Endpoint table, dependency graph, duplicate/clone report
- [ ] Gate: enumeration / entities / clone scorers (correctness)

## Slice 6 — Azure deployment prep (Bicep)  ☐ `slice/06-azure`  → **Gate G3**
- [x] ADR-0004 (Azure via Bicep) proposed; Bicep templates authored (infra/azure/): Container Apps + Postgres Flexible Server (pgvector) + Key Vault + managed identity + ACR + Log Analytics; CI compiles the Bicep
- [ ] Bicep IaC for the Azure resources (Container Apps, Postgres Flexible Server + pgvector, Key Vault + managed identity, registry, Log Analytics/App Insights), parameterised per environment
- [ ] The build-once image promoted to Azure — nothing clicked in the portal
- [ ] Gate: deployment conformance on Azure (health + migrations), rehearsed twice

## Final — the learning layer  ☐
- [ ] Per-slice "what we learned" tests narrating the real, non-linear path

---
_Human gates (⏳): accept proposed ADRs; label the judgment goldens (the eval-cases workbook)._
