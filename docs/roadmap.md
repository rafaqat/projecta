# Roadmap: the slices

Each slice is one branch that cuts through the whole stack and delivers a user-visible
capability, gated by an evaluation tier. The order follows a strict dependency chain; no
slice starts before its predecessor's gate is green. See
[`methodology.md`](methodology.md) for the per-branch lifecycle and
[`../evals/README.md`](../evals/README.md) for the gates.

## Phase 0 — Constitution

Delivered before any feature code.

- **The ADR set** — the decisions that govern every slice, accepted up front (this frame is
  `main`; the full constitution lands on `slice/00-constitution`).
- **The three eval tiers, present and red** — correctness fixtures, robustness (pinned real
  repositories with invariant thresholds), adversarial (owned, encoded).
- **The walking skeleton** — the local stack (Compose), CI that builds the image once, an
  ephemeral per-branch deploy, a self-run telemetry collector, an egress proxy, and a model
  server — everything wired, every eval runner present and reporting red.

**Exit:** structure checks green; the three tiers run and report red; a branch deploys.

## Slices 1–6

| # | Branch | Capability (user-visible) | Governing ADRs | Merge gate |
|---|---|---|---|---|
| 1 | `slice/01-identity` | Log in via real OIDC; a workspace isolates its data | authorisation, identity | Correctness: authz/IDOR matrix; two-workspace RLS ablation |
| 2 | `slice/02-ingest` | Index a repository on the hardened path; browse it | hardened ingestion, addressing | Correctness: parse/chunk/index fixtures; Robustness: ingest pinned real repos |
| 3 | `slice/03-answers` | Ask a question; get an answer with verified citations | grounding, citations, output handling, evidence gate | **Gate G1**: citation precision/recall; robustness thresholds |
| 4 | `slice/04-audit` | Every token/span attributed to a person; signed gateway; cost reconciled | telemetry, audit, signed policy, attribution | **Gate G2**: adversarial suite fail-closed; attribution coverage |
| 5 | `slice/05-structure` | Endpoint table, dependency graph, duplicate/clone report | dependencies-as-facts, clone detection, generative-UI stream | Correctness: enumeration/entities/clone scorers |
| 6 | `slice/06-azure` | Azure deployment prep: the build-once image deployed to Azure via **Bicep** IaC | build-once promotion, CI/CD trust chain, Azure target (Bicep) | **Gate G3**: deployment conformance on Azure, rehearsed twice |

Slice 6 describes the whole deployment as code — Bicep templates, parameterised per environment,
for the app and gateway (Azure Container Apps), Postgres Flexible Server with pgvector, Key Vault +
managed identity for secrets, a container registry, and Log Analytics / App Insights for the
telemetry collector. Nothing is clicked in the portal; the same image built once in CI is promoted,
and the conformance gate runs health + migrations against the provisioned Azure Postgres.

## Gates

- **G1 — submittable** (after Slice 3): the core invariants pass; answers are cited and
  verified.
- **G2 — hardened** (after Slice 4): all critical/high findings closed or accepted by a
  human; the adversarial suite fails closed.
- **G3 — Azure deploy** (after Slice 6): the same image, provisioned by Bicep, passes deployment
  conformance on Azure (health + migrations succeed), rehearsed twice.

## The learning layer (last)

After Slice 6, a per-slice layer of tests narrates the real path — the defects hit and the
decisions revisited — added honestly on top of the clean spine.
