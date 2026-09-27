---
id: ADR-0020
title: "Registration confirms the remote is reachable before it stores a repository"
status: accepted
date: 2026-09-26
supersedes: []
superseded_by: []
related: [ADR-0003, ADR-0016]
---

# ADR-0020: Registration confirms the remote is reachable before it stores a repository

## Context

Registration used to decide only on the URL's shape: the host allowlist and a safe branch name, with
no network call. A URL that passed those checks but named a repository that does not exist, is
private, or is empty was still stored and queued, and only failed later in the worker with git's own
words — "could not read Username for 'https://github.com'", or "the remote did not name a default
branch under refs/heads". A person saw a registered repository that never indexed and an error that
reads as an internal fault, not "check the URL". An unreachable host waited on the ingest's two-minute
git timeout, which reads as a hang.

## Decision

After the URL policy passes and before a new repository row is written, registration runs one bounded
reachability check on the remote: `git ls-remote --symref` under the same hardened git configuration
as ingest (terminal prompts disabled, no credential helpers), on a short timeout so a bad URL fails in
seconds rather than the ingest's two minutes. Its three failure modes map to a clear, user-facing
reason, and git's own text is never shown:

- authentication needed / a 404 / any failure to read refs → "repository not found or not accessible".
- no default branch → "repository is empty: it has no branches to index".
- the check times out → "repository unreachable: the request timed out".

A re-registration of a repository the workspace already has is unchanged: it does not re-check, so a
transient outage cannot un-register a known repository.

## Options considered

| Option | Outcome | Reason |
|---|---|---|
| Keep registration network-free; improve only the worker's error text | rejected | a doomed repository is still stored and queued; the person waits for a run to fail |
| A full clone at registration | rejected | slow and wasteful; a ref listing settles existence, emptiness and reachability |
| A bounded `ls-remote` pre-flight with mapped errors (chosen) | accepted | immediate, clear feedback at the point of entry; fails fast on a bad URL |

## Consequences

- Registration now makes one network round-trip: fast for a real public repository, and it fails fast
  on a missing, empty or unreachable one instead of registering a repository that never indexes.
- A missing, empty or unreachable remote is refused with a reason a person can act on.
- The check reuses the ingest git runner, so it inherits the same hardening (no prompts, no helpers,
  allowlisted environment) and cannot leak a credential or fetch an object it should not.

## Enforcement

A registration of a URL whose host is allowlisted but whose repository does not exist, is empty, or is
unreachable returns `ok: false` with the mapped reason and emits `ingest.rejected`; a reachable
repository registers as before. The pre-flight runs on the new-repository path only, so a
re-registration is unaffected.

## Revisit when

A remote type that `ls-remote` cannot pre-flight is supported, or registration latency from the extra
round-trip becomes a problem worth caching against.
