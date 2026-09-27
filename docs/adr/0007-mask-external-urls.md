---
id: ADR-0007
title: "Mask external URLs in answers"
status: accepted
date: 2026-09-25
supersedes: []
superseded_by: []
related: [ADR-0006]
---

# ADR-0007: Mask external URLs in answers

## Context

The gateway withholds an answer whose text contains a URL outside an allowlist:
`urlRule(policy.allowedUrlHosts)` (`services/llm-gateway/src/gateway.ts:125`) is a HoldbackStream
rule that **throws**, and a throw withholds the **entire** answer (`gateway.ts:314`, fail-closed).
Output rules are assert-only — `OutputRule.assert(text): void`
(`packages/guards/src/output_rules.ts:15`) — so today a rule can withhold, not transform. The
current allowlist is four hosts: `github.com`, `www.npmjs.com`, `nodejs.org`,
`developer.mozilla.org` (`config/gateway-policy.json:26`).

The automated red-team discovery run (ADR-0006, 2026-09-25, projectA indexed against itself)
surfaced the cost of this: a **legitimate** non-allowlisted URL from the indexed codebase tripped
the URL control, even though no attack payload leaked (marker contained, zero-tolerance counters
clean). Withholding a whole answer over a benign link is poor UX; the allowlist is a maintenance
and bypass surface; and a grounded code assistant cites code as `file:line`, not as clickable
external links — it has no need to emit them.

## Decision

The assistant never renders external URLs. At the gateway egress, external `http(s)` URLs in the
answer are **masked** — replaced with a fixed redaction token (e.g. `[external link hidden]`) —
instead of withholding the whole answer, and the user is shown a notice ("external links are hidden
for security") through the existing withheld/legend mechanism (`app/assistant/withheld_span.ts`).

This applies **only to the URL rule**. The secret, canary, honeytoken and raw-HTML rules keep their
assert/withhold (fail-closed) behaviour — a leaked secret is never masked, it withholds. To mask at
the egress boundary, output rules gain a masking capability: a rule may transform the text (return a
masked string) instead of only asserting, applied by the HoldbackStream the way it already masks
inbound content. If masking cannot guarantee removal (an obfuscated/split URL the normaliser cannot
resolve), the rule falls back to withholding (fail-closed).

## Options considered

| Option | Outcome | Reason |
|---|---|---|
| Keep withhold-whole-answer + allowlist | rejected | a benign repo URL costs the whole answer (discovery run); the allowlist is a maintenance + bypass surface |
| **Mask external URLs at egress + notice (blanket)** | **proposed** | preserves the answer, kills the URL-exfil / malicious-link vector, transparent; code is cited as `file:line`, not URLs |
| Mask only non-allowlisted URLs (keep the 4-host allowlist) | alternative | keeps dev-reference links (github/npm/nodejs/mdn) but retains an allowlist to maintain — owner's call at acceptance |
| Mask in the app render layer (post-gateway) | rejected | the URL has already crossed the egress boundary; the mask must be at the gateway to be the control (INV-02) |

## Consequences

- New capability in `packages/guards`: an output rule can **mask** (transform), not only assert; the
  URL rule becomes a mask rule. Every other rule is unchanged (withhold, fail-closed).
- Whole-answer withholding for URLs is **relaxed to masking** — a deliberate trade of a fail-closed
  control for UX + transparency, sound because a URL (unlike a secret) is a display choice, not a
  signal that the answer is compromised.
- `allowedUrlHosts` is removed under the blanket option (the config field retired), or emptied under
  the allowlist option.
- The user always receives the answer, with links masked and a notice explaining why.
- The egress boundary (INV-02) is preserved: masking happens at the gateway, not in the client.

## Enforcement

- The live-lane eval `no_external_urls_in_output` still passes (masked = no URL reaches the client);
  add a check that the masking notice appears when a URL was masked.
- A `packages/guards` unit test: the URL rule masks a non-allowlisted URL to the token, and falls
  back to withhold when it cannot guarantee removal (an obfuscated URL).
- The mask is normalisation-aware (reuses the HoldbackStream normaliser), so homoglyph / zero-width
  / split URLs are caught exactly as the assert path catches them today.

## Revisit when

- A masking bypass is found (a URL reaches the client) — tighten the normaliser or revert the URL
  rule to withhold.
- A real need arises to show specific external links (e.g. a docs integration) — reintroduce a
  narrow allowlist as an amendment.
