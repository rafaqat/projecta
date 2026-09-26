---
id: ADR-0018
title: "Output is rendered as data: one sanitiser, one stream encoder, and a link and command policy"
status: accepted
date: 2026-09-26
supersedes: []
superseded_by: []
related: [ADR-0007, ADR-0012, ADR-0013]
---

# ADR-0018: Output is rendered as data: one sanitiser, one stream encoder, and a link and command policy

## Context

An answer is assembled from model text and from repository content, and both are untrusted for the
purpose of rendering: a code comment can contain a script tag, a model can emit a link or a shell
command that exfiltrates on click or on paste. If any component can inject raw HTML, or if a link or a
command reaches the reader unchecked, the answer becomes an attack surface against the person reading
it.

## Decision

Everything shown to the reader is treated as data. Rich content is rendered only through a single
sanitising component (`inertia/components/safe_html.tsx`); raw HTML injection anywhere else is
forbidden. The streamed answer is encoded through one SSE encoder so there is a single place that
decides what leaves, and the gateway's hold-back checks that stream before it is shown (ADR-0012). A
link and command policy applies at that boundary: external URLs are masked rather than rendered, and
content shaped like a runnable command is not presented as one. A content security policy backs the
page so that even a rendering mistake cannot execute injected script.

## Options considered

| Option | Outcome | Reason |
|---|---|---|
| Trust components to escape their own output | rejected | one missed escape is an injection; no single place to audit |
| Render links and commands as-is | rejected | a link or a pasted command is an exfiltration and execution vector |
| One sanitiser, one stream encoder, a link/command policy, a CSP (chosen) | accepted | a single audited boundary for everything the reader receives |

## Consequences

- Raw HTML has exactly one sanctioned path to the reader; anything else is a lint failure.
- External URLs are masked; the reader is told a link was hidden rather than shown a live one.
- The SSE encoder is the single egress point for streamed text, checked by the gateway hold-back.
- A CSP is a second line so that a render bug cannot escalate to script execution.

## Enforcement

A lint rule fails on raw HTML rendering outside the sanitiser. A test proves an external URL in an
answer is masked and that a script tag in repository content is not executed when rendered. The SSE
encoder is the only stream path, covered by the gateway conformance suite.

## Revisit when

A new output surface is added that the single sanitiser and stream encoder cannot cover as-is.
