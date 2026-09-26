---
id: ADR-0016
title: "The turn is an explicit, bounded tool loop, not an orchestration framework"
status: accepted
date: 2026-09-26
supersedes: []
superseded_by: []
related: [ADR-0013, ADR-0014]
---

# ADR-0016: The turn is an explicit, bounded tool loop, not an orchestration framework

## Context

Answering a question can require several steps: retrieve, read a symbol, follow a reference, retrieve
again. A framework can express that, but it also hides the control flow behind abstractions, makes the
bounds implicit, and pulls in a dependency whose behaviour must be trusted in a security-sensitive path.
For a turn that must be attributable, bounded and testable, the control flow is the thing that most
needs to be visible.

## Decision

The turn is an explicit loop in application code (`app/assistant/agent.ts`). The model is offered a
fixed set of read-only tools that query the index; it may call them over a small, hard-capped number of
rounds and within per-tool and per-turn time limits, after which the loop stops and the turn answers
from what it has. The tools cannot write, cannot reach the network, and run under the turn's tenancy
scope. There is no orchestration framework: the loop, the caps and the tool surface are ordinary code
that can be read and tested directly.

## Options considered

| Option | Outcome | Reason |
|---|---|---|
| An agent orchestration framework | rejected | hides control flow, implicit bounds, a trusted dependency in a sensitive path |
| A single model call with all context up front | rejected | cannot follow a reference or retrieve again based on what it found |
| An explicit, hard-bounded read-only tool loop (chosen) | accepted | control flow, bounds and tool surface are visible and testable |

## Consequences

- The loop's bounds are explicit constants, not a framework's defaults.
- Every tool is read-only and index-scoped, so a turn cannot mutate state or exfiltrate.
- A runaway or looping turn stops at a known limit and answers from what it has.
- The turn has one fewer trusted third-party dependency in its critical path.

## Enforcement

A test asserts the loop halts at its round and time caps. Every registered tool is read-only and runs
under the turn's scope; a tool attempting a write or a network call fails. Importing the agent module
from outside its single construction site is a lint failure.

## Revisit when

A turn legitimately needs a step the bounded read-only tool surface cannot express.
