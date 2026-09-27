---
id: ADR-0012
title: "The model is reached only through a thin egress gateway that binds every call to a person"
status: accepted
date: 2026-09-26
supersedes: []
superseded_by: []
related: [ADR-0002, ADR-0003, ADR-0007]
---

# ADR-0012: The model is reached only through a thin egress gateway that binds every call to a person

## Context

The assistant calls a hosted model. Two risks follow from that single fact: the provider SDK, if it
can be imported anywhere, becomes an ungoverned egress path out of the process; and a model call with
no attribution cannot be tied to the person who caused it, so cost and misuse cannot be accounted for.
The application also needs one place to enforce what may leave and what may come back, rather than
scattering that logic across every call site.

## Decision

All model access goes through a single network gateway (`services/llm-gateway/`), and the provider SDK
lives only in `app/llm/client.ts`. The gateway is **egress-only** and holds no application data. Every
request carries an EdDSA attribution token that binds the exact request body to a person and is
verified against a signed policy (`policy.ts`, `attribution.ts`); one ledger row is written per call.
Inbound requests carrying a secret, a disallowed URL or a foreign honeytoken are refused with 403
before the provider sees them, and the streamed response is held back and checked before it reaches the
reader. What the application presents as an "API key" is a gateway token, never a provider credential.

## Options considered

| Option | Outcome | Reason |
|---|---|---|
| Import the provider SDK where convenient | rejected | every import is an unaudited egress path; no single control point |
| Attribute calls in application code | rejected | attribution not bound to the request body can be forged or omitted |
| Thin egress gateway, SDK confined to one client, request-bound attribution (chosen) | accepted | one boundary to enforce egress, one place that proves who caused each call |

## Consequences

- The provider SDK boundary is a single file; a call from anywhere else is a lint failure.
- Every model call is attributable and ledgered; cost and misuse have an owner.
- The gateway is a fail-closed choke point: a rule violation withholds the whole answer.
- A signed policy must be re-signed whenever the validated configuration changes, including on deploy.

## Enforcement

A lint rule fails if the provider SDK is imported outside `app/llm/client.ts`. A conformance suite
asserts the gateway forwards the byte-identical body under the provider prefix with the attribution
token and no raw provider key, and that an unsigned or altered policy prevents the gateway from
starting. An inbound request carrying a secret or foreign honeytoken is refused 403 in test.

## Revisit when

A second model provider is required, or attribution must span more than one call in a turn.
