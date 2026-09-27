---
id: ADR-0004
title: "Azure deployment as Bicep: the build-once image promoted to Azure Container Apps, described entirely as code"
status: proposed
date: 2026-09-21
supersedes: []
superseded_by: []
related: ["ADR-0001", "ADR-0002", "ADR-0003"]
---

# ADR-0004: Azure deployment (Bicep)

## Context

Slice 6 is deployment prep: the same build-once image (ADR-0001) reaches Azure with nothing clicked
in the portal. Azure Container Apps is the deployment target, but the infrastructure was never
written — `infra/` was empty. This slice supplies it as **Bicep**.

## Decision

The whole deployment is Bicep under `infra/azure/`, parameterised per environment
(`main.<env>.bicepparam`):

1. **Azure Container Apps** host the `app` and `llm-gateway` containers as revisions, with a
   managed identity and internal ingress; the same image digest built once in CI is promoted.
2. **Azure Database for PostgreSQL Flexible Server** with the `vector` extension allow-listed and a
   database per environment — the app connects as the non-superuser role (ADR-0003) so row-level
   security enforces.
3. **Key Vault + a user-assigned managed identity** hold and read secrets (APP_KEY, DB and OIDC
   credentials, the gateway policy key); no secret is a plaintext env value.
4. **Azure Container Registry** stores the signed image; **Log Analytics** backs the self-run
   telemetry collector (ADR-023's allowlist still applies).
5. **Deploy conformance** (G3): after `az deployment`, the promoted image passes health + migrations
   against the provisioned Postgres, rehearsed twice.

## Options considered

| Option | Outcome | Reason |
|---|---|---|
| Bicep IaC, Container Apps, one promoted digest (this ADR) | **Proposed** | Native Azure IaC; matches the ADR-012 target; nothing clicked |
| Terraform | Rejected | Bicep is first-party for Azure; no extra state backend to run |
| Portal / scripts | Rejected | Not reproducible; not reviewable as code |

## Consequences

- The deployment is reviewable and reproducible; a new environment is a new `.bicepparam`.
- `az bicep build` validates the templates in CI; a full `az deployment` needs Azure credentials
  (a human task), so CI lints/compiles the Bicep rather than deploying.

## Enforcement

- CI compiles the Bicep (`az bicep build infra/azure/main.bicep`) on every change.
- The deploy-conformance test (ported) runs health + migrations against the deployed image (G3).

## Revisit when

- The provider model changes (e.g. Claude via Foundry vs the gateway) or a managed Postgres with
  native pgvector supersedes the Flexible Server extension.
