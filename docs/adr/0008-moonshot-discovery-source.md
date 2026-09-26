---
id: ADR-0008
title: "Moonshot recipes as a discovery attack source"
status: accepted
date: 2026-09-25
supersedes: []
superseded_by: []
related: [ADR-0006]
---

# ADR-0008: Moonshot recipes as a discovery attack source

## Context

ADR-0006 established the automated adversarial discovery lane (Architecture A): offline generators
produce candidate attacks, the existing live lane (`redteam:run --live`) executes and scores them
against this product's containment oracles, and a person promotes real breaches into the frozen
regression set. PyRIT converters are the first generator.

Moonshot (AI Verify Foundation) publishes **recipes** — JSON test suites bundling a dataset +
metrics + prompt templates. Its catalogue is broad, but most recipes assume a general-purpose
chatbot (toxicity, bias, CBRNE, hate, MMLU/GSM8K knowledge, TruthfulQA). projectA is a tenant-
isolated, citation-grounded code assistant whose scope classifier and evidence gate refuse
generative/off-topic requests before any model call, so those recipes would mostly measure the
scope gate's refusal, not the code-assistant threat surface — and they ship non-deterministic
LLM-judge metrics (gpt4annotator, llamaguardannotator) that need a judge model. A narrow subset
does add coverage the existing generator lacks: prompt-injection (including CyberSecEval-PI's
multilingual variants), jailbreak (DAN), adversarial-robustness (AdvGLUE), and privacy-leakage
(EnronEmail).

## Decision

Add Moonshot as a **second discovery-lane attack source** (still Architecture A), scoped to recipes
that add coverage of threats already in `evals/redteam/threats.yaml`:

| Recipe class | Adds | Maps to |
|---|---|---|
| CyberSecEval – Prompt Injection (+ multilingual) | non-English injection, a real gap | injection / T-01 |
| Jailbreak-DAN / Jailbreak Prompts | persona-override jailbreaks | injection / T-01 |
| AdvGLUE | word/sentence adversarial transforms | routing/retrieval robustness |
| EnronEmail leakage | private-data extraction prompts | T-02 secret / T-03 cross-tenant |

Only recipes that add **new** coverage are imported: each candidate prompt is de-duplicated
(MinHash, as `redteam:generate` already does) against the existing seeds and PyRIT variants; a
prompt that adds no new technique/language/threat-instance is dropped. The general-chatbot-safety
recipes (toxicity, bias, CBRNE, knowledge, hallucination) are **excluded** — out of scope for a
scope-gated grounded assistant, and dependent on LLM-judge metrics.

Imported prompts are treated exactly like PyRIT output: staged, base64 at rest, scored by **this
product's** containment oracles (not Moonshot's metrics), offline/UAT only, and promoted into the
frozen set only by a person (R-06/R-08). `threats.yaml` is not edited — this adds coverage of
existing threats, not new threats.

## Options considered

| Option | Outcome | Reason |
|---|---|---|
| Import the whole Moonshot catalogue | rejected | most recipes are general-chatbot safety, out of scope; LLM-judge metrics are non-deterministic |
| **Import only the injection/jailbreak/leakage subset that adds coverage** | proposed | fills real gaps (multilingual injection, DAN) with no scope/determinism cost |
| Adopt Moonshot's scorers/metrics too | rejected | duplicates our oracles, needs a judge model, breaks key-free determinism |
| Edit threats.yaml to add Moonshot categories | rejected | R-06; recipes are test content, not threats |

## Consequences

- A Moonshot importer under `evals/redteam/tools/` (offline, Python) fetches the chosen recipes,
  extracts their prompts, de-duplicates against existing corpora, maps each to a threat, and writes
  staged seeds (base64) for the discovery bridge to consume.
- Discovery coverage gains non-English injection and persona-jailbreak techniques the converters
  cannot synthesise.
- No change to CI, the deterministic regression, `threats.yaml`, or the oracles.
- New dependency footprint only in the offline tools env (not the app).

## Enforcement

- **Licensing gate (blocking):** each dataset's licence and ethical-use terms are verified and
  recorded in a manifest before it lands; a dataset with an incompatible or uncertain licence is
  excluded. Moonshot's own licence and each dataset's are checked separately.
- De-duplication (MinHash) against existing seeds + PyRIT variants; a canary/ablation proves the
  dedup drops a known-duplicate so "extra tests only" is mechanical, not asserted.
- Imported prompts are base64 at rest and denied to file tools, like every other payload; scored by
  the existing oracles; run offline only (absent from CI); promotion into `regression.json` stays a
  human step.

## Revisit when

- Moonshot publishes new injection/jailbreak recipes (re-run the import + dedup).
- A scope-gate refusal test (from the excluded safety subset) becomes worth running against the gate
  — reconsider that subset as a separate, scope-gate-targeted lane.
