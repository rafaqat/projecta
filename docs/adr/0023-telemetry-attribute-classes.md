---
id: ADR-0023
title: "Telemetry carries three classes of attribute; content is a developer affordance, not a deployment setting"
status: proposed
date: 2026-09-28
supersedes: []
superseded_by: []
related: [ADR-0012, ADR-0015, ADR-0016, ADR-0017]
---

# ADR-0023: Telemetry carries three classes of attribute; content is a developer affordance, not a deployment setting

## Context

SEC-14 keeps request content out of telemetry. The exporter allowlists span attributes before
anything leaves the process and the Collector redacts again, and absent by design are `url.full`,
`url.path`, `url.query`, `db.query.text`, exception messages, and request and response bodies.
That policy is correct and has held. It has also now failed twice in the same way, in opposite
directions.

**It made a failure unreadable.** Because the message is dropped, the error code is the whole of
what an operator sees. The code was derived from `error.name`, and no error class in the provider
SDK assigns `name`, so a connection failure, a timeout, a 429 and a 500 all arrived as
`E_MODEL_Error`. The complaint was recorded during UAT on 2026-09-16 ("three E_MODEL_Error with
nothing to open") and recurred on 2026-09-27, when a turn met the gateway mid-restart and the only
readable fact, `getaddrinfo EAI_AGAIN llm-gateway`, survived solely because a span's status message
is an intrinsic rather than an attribute and the allowlist never saw it.

**It makes a turn unreconstructable.** A turn is a scope decision, a seed ladder, an evidence pack,
up to five rounds of a tool loop, the tools each round requested, and a termination reason
(ADR-0016). None of that is in telemetry: the only application spans are the ones auto-instrumentation
produces for HTTP and the database, so a turn appears as one server span, some queries, and an
anonymous outbound POST. For debugging and for security operations on a developer's own stack, that
is not enough to answer "what did this turn actually do".

The tempting fix is a single switch that turns turn telemetry on. That trades blind production for
leaky production and settles nothing.

## Decision

Telemetry attributes fall into three classes, and each is governed differently.

**1. Structural.** Counts, labels, statuses and identifiers from closed sets: the run handle, the
scope label and stage, the seed source, retrieval and evidence counts, the round number, the tool
name, the tool status, the stop reason, token counts, the gate mechanism. These are always exported,
in every environment. They carry no free text and cannot carry content, because the values come from
enumerations the application defines.

**2. Cause.** The error class taken from the constructor rather than `name`, and the operating
system's errno beneath a transport failure (`EAI_AGAIN`, `ECONNREFUSED`), exported as
`app.error.code` and `app.error.cause`. An errno is libuv's closed set and a class name is the SDK's
own vocabulary, so both are safe where a message is not. Always exported.

**3. Content.** The question, the answer, the withheld text, tool arguments and results, evidence
paths, seed names. Exported only while all three of the following hold:

- `TELEMETRY_DEBUG_CONTENT=1`;
- `APP_ENV` is `local` or `test`, so uat and production are excluded whatever the flag says;
- the Collector's own allowlist carries the attributes, which a deployed Collector does not.

The third key is held outside the application deliberately, so no single mistake inside the
application exports a prompt. Values are capped at 2 KB and marked when truncated.

The boot guard refuses to start uat or production with the flag set, so a flag that escapes into a
deployed environment is a loud failure at boot rather than a quiet one at export.

## Options considered

| Option | Outcome | Reason |
|---|---|---|
| Keep SEC-14 unchanged | Rejected | The code stays the only readable fact and the code was not distinguishing failures; a turn stays unreconstructable |
| Export the error message, capped | Rejected | A message is free text from a provider, and a provider that echoes request content puts content in telemetry through a path nothing audits |
| One switch for all turn telemetry | Rejected | Production then has either no turn observability or content in it; structural facts are the ones production most needs and the ones that carry no risk |
| Three classes, content behind two keys plus the Collector | **Chosen** | Production keeps full structural forensics; content is available exactly where the repository, the questions and the stack belong to the person reading them |
| Content behind a flag alone | Rejected | A flag set in the wrong environment would be sufficient; the environment check and the Collector make a single mistake insufficient |
| Read the question from the database instead | Partly retained | Correlation by run handle remains the route in production, where RLS decides who may read it; it does not serve a developer reconstructing a loop locally |

## Consequences

- Production and uat traces describe the shape of every turn: which round, which tool, which status,
  why it stopped. They contain no question, answer or tool argument, and no flag can change that.
- A developer reproducing a turn locally sees the question, the evidence and the tool arguments in
  the same waterfall as the timings.
- Grafana access on a developer stack implies access to that developer's questions. This is stated
  rather than mitigated: the stack, the repository and the questions are the same person's.
- The Collector configuration becomes security-relevant. `docker/otel/collector.yaml` is the
  developer stack's; a deployed Collector must not carry the content block, and that is now a
  reviewable difference rather than an implicit one.
- Two allowlists must agree for a new attribute to appear, which makes adding one deliberate and
  makes a forgotten entry a silent drop. The tests below exist for that reason.

## Enforcement

- `contentTelemetryEnabled()` (`app/security/telemetry/debug_content.ts`) is the single decision
  point; every call site goes through `contentAttributes()` rather than checking the flag itself.
- `evaluateBootGuards` refuses to start when `TELEMETRY_DEBUG_CONTENT` is set and `APP_ENV` is not
  `local` or `test`; `TELEMETRY_DEBUG_CONTENT` is also in `FORBIDDEN_FLAGS`.
- `tests/unit/security/debug_content.spec.ts` asserts the gate is false for uat and production with
  the flag set, and that the boot guard names the flag in its violations.
- `tests/unit/assistant/model_error.spec.ts` asserts `errorCause` survives the catalogue and reaches
  `app.error.cause`; removing the field from either allowlist turns it red.
- Verified on the running stack in both states: with the flag set, a turn's span carries
  `app.turn.question`; with it unset, the same question string appears zero times in the exported
  trace while all nineteen structural attributes remain.

## Revisit when

A deployment needs turn content for an incident it cannot reproduce locally, which would mean the
correlation route through the run handle is insufficient in practice rather than in principle; or a
provider begins returning structured error causes, which would make the errno redundant; or the
structural attribute set grows large enough that the two allowlists drift, which the tests would
show as an attribute that is set and never exported.
