---
id: ADR-0024
title: "Profiles leave the process without passing the Collector: a stack frame is a symbol, not data"
status: accepted
date: 2026-09-28
supersedes: []
superseded_by: []
related: [ADR-0012, ADR-0023]
---

# ADR-0024: Profiles leave the process without passing the Collector: a stack frame is a symbol, not data

## Context

ADR-0023 sorted telemetry attributes into three classes and put every one of them behind two
allowlists: the exporter's, inside the process, and the Collector's redaction stage outside it.
That covers traces, logs and metrics, which are the three pipelines the Collector carries.

Continuous profiling adds a fourth path. The application pushes pprof payloads straight to
Pyroscope on port 4040; the Collector is not in that path, so neither allowlist applies to it. That
is a new way for bytes to leave the process and it deserves a decision rather than an implementation
detail in a module docblock.

The reason to want it: a trace says round six of a turn took 11.9 seconds. It does not say whether
that was the provider, the parser or the evidence gate, and the difference decides what to do next.
Measured on the running stack, a profile answers it: 3.3 billion wall-clock nanoseconds across 767
frames, 47 of them this application's, naming `turn_service:answerTurn` and `evidence_gate:apply`.

## Decision

Profiles are exported directly to Pyroscope without passing the Collector, because what a profile
contains is not the kind of thing the allowlists exist to stop.

A profile is stack frames: function names, file paths, line numbers and sample counts. The
allowlists exist because a span attribute is a place a question could be put, and a log field is a
place an answer could be put. A stack frame is not such a place. It is drawn from the program text,
which is the binary, not the data flowing through it.

Three constraints make that true rather than merely likely:

1. **Tags are a fixed low-cardinality set**: service version, environment, and a role that separates
   the worker's flame graphs from the web process's. Never a user, never a workspace, which is the
   same rule the metric attributes follow and for the same two reasons: a per-tenant series grows
   without bound, and it would say who was working.
2. **The labels API is not used.** `@pyroscope/nodejs` exposes `wrapWithLabels`, which attaches
   arbitrary key-value pairs to the samples taken inside a callback. That is a place a question
   could be put, so it is out of bounds, and a test asserts the application does not call it.
3. **No dynamically generated function names.** A frame is only as safe as the code it names. Code
   built at runtime from input, through `eval` or `new Function`, would put that input in a frame
   name. The application does not do this.

Profiling is off unless `PYROSCOPE_SERVER_ADDRESS` is set, and starting it is best effort: a
profiler that cannot reach its server reports `E_PROFILER_UNAVAILABLE` and the process boots
without profiles, because an observability component must not decide whether the application runs.

Unlike content telemetry (ADR-0023), profiling is **not** restricted to a developer's stack. It
carries no content, and the environment that benefits most from knowing where time goes is the one
serving real traffic.

## Options considered

| Option | Outcome | Reason |
|---|---|---|
| Route profiles through the Collector | Rejected | The Collector has no profiles pipeline in this deployment, and OTLP profiles are still experimental; adopting an experimental signal to gain a redaction stage that has nothing to redact is the wrong trade |
| Do not profile | Rejected | The question a profile answers, which code made a round slow, has no other answer; the trace bounds it and stops |
| Profile only on a developer stack, behind the content flag | Rejected | That flag exists for request content, and a profile has none. Gating on it would deny production the signal it most needs and would imply profiles are content, which is the confusion this record exists to prevent |
| Push directly, fixed tags, labels API forbidden | **Chosen** | The payload is symbols; the three constraints above keep it that way, and one of them is enforced by a test |

## Consequences

- A fourth egress path exists from the application, to Pyroscope, outside the Collector. A reader of
  the Collector configuration no longer sees everything that leaves; this record and
  `app/security/telemetry/profiling.ts` are where the rest is.
- `otel-lgtm` had to join `NO_PROXY`. Without it the push is routed to Squid, which allows CONNECT
  to 443 and the model server and nothing else, so the profiler would have failed silently against
  a proxy that was working correctly.
- Flame graphs name the application's files and functions. Anyone with access to Pyroscope can read
  the shape of the source, which is a smaller disclosure than the source itself and a real one.
- `@datadog/pprof` is a native dependency. It ships prebuilds for linux-x64, linux-arm64 and
  darwin-arm64 and its install script is a no-op, so the image's `npm ci --ignore-scripts` needs no
  change, but an architecture without a prebuild would need one.
- The profiler samples continuously in production, which costs a little CPU and appears in its own
  flame graph alongside the telemetry exporters.

## Enforcement

- `startProfiling()` (`app/security/telemetry/profiling.ts`) is the only place the profiler is
  configured, and it returns false rather than throwing when the server address is absent.
- Tags are a literal in that function; there is no path by which a caller supplies one.
- `tests/unit/security/profiling.spec.ts` asserts the application never calls `wrapWithLabels`, so
  the one API that could put content in a profile cannot be introduced without the test failing.
- Verified on the running stack: `wall:wall:nanoseconds{service_name="projectA"}` carries 767
  frames, 47 from this application, separated by `role` into web and worker.

## Revisit when

OTLP profiles leave experimental and the Collector gains a profiles pipeline, which would allow one
redaction point for every signal and is worth taking then even though there is nothing to redact
now; or the application acquires a code path that builds functions at runtime, which would make a
frame name a place input can reach; or a deployment needs per-tenant profiling, which would break
the low-cardinality rule and needs its own decision.
