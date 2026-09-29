---
id: ADR-0025
title: "Turn content rides a log record, not a span attribute; the third key moves with it"
status: proposed
date: 2026-09-29
supersedes: [ADR-0023]
superseded_by: []
related: [ADR-0012, ADR-0015, ADR-0016, ADR-0017, ADR-0024]
---

# ADR-0025: Turn content rides a log record, not a span attribute; the third key moves with it

## Context

ADR-0023 sorted telemetry attributes into structural, cause and content, and put content on span
attributes behind three keys: the `TELEMETRY_DEBUG_CONTENT` flag, an `APP_ENV` of `local` or `test`,
and the Collector's own allowlist, which a deployed Collector does not carry. The gate held. The
carrier did not, and two facts came out of using it.

**Tempo truncates a span attribute at 2048 bytes, silently.** `max_attribute_bytes` is a Tempo
default, not an SDK limit — the SDK's own `attributeValueLengthLimit` is `Infinity`, and the
Collector's OTLP receiver accepts four mebibytes per message, so nothing between the application and
storage reports the loss. A request array does not fit in 2 KB. What arrived was its first 2 KB, and
a truncated request array answers no question anyone would ask it: the interesting part of "what did
the model see" is rarely in the first two kilobytes. ADR-0023 spent a paragraph deciding that a cap
belongs to its attribute, and that was work in service of a carrier that could not hold the payload
at any cap.

**Some of the content was never there at all.** `app.model.messages` is the array the model was
*sent*. The answer it produced, and the sentences the evidence gate withheld, are not in it. Neither
had an attribute, so the arrangement was not merely truncating the record of a turn; for the two
things a reviewer most wants to compare — what was released against what was held back — it had no
record to truncate. This is the same silent-absence failure ADR-0023 describes in its own
consequences, arriving through the carrier rather than through a forgotten allowlist entry.

A further consequence of changing carrier was not obvious until this decision was written down, and
is the reason it is written down: **the third key does not survive the move as it stood.** The
Collector's allowlist could withhold content because the content *was* the attribute. A log record's
body is not an attribute, `redaction` governs attributes only, and so removing `app.content.kind`
from a deployed allowlist strips the record's label and forwards the prose inside it. Left alone,
this decision would have quietly demoted a three-key control to a two-key one.

## Decision

The three classes stand. Structural and cause attributes are unchanged from ADR-0023 and restated
here so that one document describes the whole arrangement.

**1. Structural.** Counts, labels, statuses and identifiers from closed sets: the run handle, the
scope label and stage, the seed source, retrieval and evidence counts, the round number, the tool
name and status, the stop reason, the gate mechanism. Always exported, in every environment. The
values come from enumerations the application defines, so they cannot carry content.

**2. Cause.** The error class taken from the constructor rather than `name`, and the operating
system's errno beneath a transport failure, as `app.error.code` and `app.error.cause`. Always
exported.

**3. Content.** Content leaves spans. It is written as a log record whose body carries the payload
whole and uncapped, labelled `app.content.kind`, in four kinds:

| kind | what it holds |
|---|---|
| `turn` | the turn as a narrative: the question, the scope and the rule that set it, retrieval and the evidence it chose, the seeds, each round with the tool it ran, and how it ended |
| `messages` | the request array, whole |
| `answer` | what the evidence gate released |
| `withheld` | what it held back, which no other signal carries |

There are no content caps. A cap existed to fit content into a span, and a capped content record is
worse than no content record, because it reads as the whole thing. `exportedBodyOf` keeps its
160-byte cut for every other log body and makes one named exception for these, under the same gate.

Spans keep structure and timing and carry no text. The run handle is on every record and every span,
so a log opens its trace and a trace opens its logs.

**The keys are still three, and the third still lives outside the application.** It moves from an
allowlist entry to the Collector's own environment:

- `TELEMETRY_DEBUG_CONTENT=1` in the application;
- `APP_ENV` is `local` or `test`, so uat and production are excluded whatever the flag says;
- `OTEL_ALLOW_CONTENT_LOGS=1` in the Collector's environment, without which `filter/content` drops
  every record carrying `app.content.kind` before any exporter sees it.

Two properties of the old third key are deliberately preserved. **Omission is safe:** an unset
variable drops, so a deployed Collector that configures nothing is the correct one, exactly as a
deployed allowlist that omits a block was. **The names differ:** the Collector's key is not called
`TELEMETRY_DEBUG_CONTENT`, so a single `export` in a shared environment file cannot open both, which
is what ADR-0023 wanted from a key held in another process.

One property improves. The old third key was an absence in a file kept outside this repository, so
nothing here could test it. The new one is a processor in the committed configuration, which a test
reads and an ablation proves.

The boot guard is unchanged: uat and production refuse to start with `TELEMETRY_DEBUG_CONTENT` set.

## Options considered

| Option | Outcome | Reason |
|---|---|---|
| Keep content on span attributes, raise Tempo's `max_attribute_bytes` | Rejected | Attempted; the image's config already defines `overrides`, and the fork failed on `field defaults not found in type overrides.legacyConfig`. It also makes every reader's Tempo a prerequisite for reading a turn |
| Keep span attributes, accept 2 KB | Rejected | A truncated request array reads as a whole one, and the answer and withheld text have no attribute to truncate |
| Split content across several span attributes to stay under the cap | Rejected | Reassembling a prompt from numbered fragments in a waterfall is worse than reading it, and the fragment count becomes a new thing to get wrong |
| Content as a log record's body, uncapped | **Chosen** | Loki stores it whole, the run handle correlates it to the trace, and reading one turn is a reading task rather than a timing one |
| Log record, and accept two keys | Rejected | It is a weakening introduced by a carrier change nobody asked to weaken anything, and it would have gone unnoticed had this decision not been written down |
| Third key as a stripping processor a deployed Collector must add | Rejected | Fail-open: forgetting it forwards prompts. The control must run in the direction where forgetting is safe |
| Third key as the Collector's own env var, drop unless set | **Chosen** | Fail-safe on omission, held in a second process under a second name, and committed here where a test can read it |
| Content in a log *attribute* so `redaction` still governs it | Rejected | It restores the allowlist as the third key, but Loki carries log attributes as structured metadata with size limits of its own, which reintroduces the silent truncation this decision exists to remove |

## Consequences

- Production and uat carry the full structural and cause picture of every turn and none of its text,
  and now two independent processes must both be misconfigured for that to change.
- A developer reproducing a turn reads it as a narrative, in order, rather than reconstructing it
  from a waterfall. The waterfall remains, and is the right tool for the one question it answers
  better: where the time went.
- The withheld text is observable for the first time, which is what makes an evidence-gate decision
  reviewable rather than merely countable.
- Grafana access on a developer stack implies access to that developer's questions. Unchanged from
  ADR-0023 and still stated rather than mitigated: the stack, the repository and the questions belong
  to the same person.
- `docker/otel/collector.yaml` stays security-relevant, but for a processor that is present rather
  than a block that must be absent, which is the reviewable direction.
- An empty content panel on a deployed stack is the correct result. The dashboard says so on each
  such panel, because "this panel is empty" and "this panel is broken" otherwise look identical —
  the same silent-absence problem this ADR keeps meeting.

## Enforcement

- `contentTelemetryEnabled()` (`app/security/telemetry/debug_content.ts`) remains the single decision
  point, and `logTurnContent()` (`content_log.ts`) is the only writer of a content record.
- `evaluateBootGuards` refuses to start uat or production with `TELEMETRY_DEBUG_CONTENT` set;
  the flag remains in `FORBIDDEN_FLAGS`.
- `tests/unit/security/debug_content.spec.ts` asserts the gate is false for uat and production with
  the flag set, that a content record keeps its body, and that nothing else does.
- `tests/unit/security/collector_content_gate.spec.ts` asserts the logs pipeline carries
  `filter/content` ahead of its exporters, that the condition drops when the key is *absent* rather
  than when it is present, and that the Collector's key does not share a name with the application
  flag. Ablated in both directions: removing the processor from the pipeline and inverting the
  comparison each turn it red.
- `tests/unit/security/declared_attributes.spec.ts` fails on an allowlisted `app.*` key that nothing
  writes, which is what caught the content attributes' entries outliving the attributes themselves.
- Verified against a running Collector at the pinned contrib image, posting one record labelled
  `app.content.kind` and one not: with `OTEL_ALLOW_CONTENT_LOGS` unset the labelled body is absent
  from the export and the other survives; with it set to `1` both survive.

## Revisit when

Loki's ingestion limits start truncating a body, which would mean the carrier has the same defect as
the last one and the payload belongs in object storage keyed by run handle; or a deployment needs
turn content for an incident it cannot reproduce, which would make correlation by run handle through
the database insufficient in practice rather than in principle; or Tempo gains an attribute limit
large enough to hold a request array, which would not by itself move content back, because reading a
turn would still be a reading task.
