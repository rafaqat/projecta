# Moonshot discovery source — licensing & provenance manifest (ADR-0008)

The discovery lane (ADR-0006) may import external attack corpora as extra coverage of threats
already in `evals/redteam/threats.yaml`. ADR-0008 makes licensing a **blocking gate**: a dataset is
imported only if its licence and ethical-use terms are compatible with this repository (Apache-2.0,
permissive, commercial-use permitted) and its provenance is clear. Imported prompts are staged
base64 (denied to file tools), scored by *this* product's oracles, offline/UAT only, and promoted
into the frozen set only by a person (R-06/R-08).

## Decisions

| Dataset | Source | Licence | Decision | Reason |
|---|---|---|---|---|
| Moonshot framework & recipe configs | `aiverify-foundation/moonshot` | Apache-2.0 | reference | recipe structure is permissive; we consume prompts, not metrics |
| **CyberSecEval — Prompt Injection** (incl. multilingual) | `meta-llama/PurpleLlama` | **MIT** | **INCLUDE** | permissive; fills the multilingual-injection gap converters can't synthesise (→ T-01/injection) |
| **Jailbreak-DAN / in-the-wild jailbreaks** | `verazuo/jailbreak_llms` (Shen et al., CCS'24) | **MIT** | **INCLUDE** | permissive; persona-override jailbreak wrappers (→ T-01/injection) |
| AdvGLUE | `AI-Secure/adv_glue` | **CC BY-SA 4.0** | **EXCLUDE** | ShareAlike copyleft is incompatible with an Apache-2.0 clean-provenance submission |
| EnronEmail (leakage) | CMU CALO / FERC release | non-commercial research; real PII | **EXCLUDE** | non-commercial restriction conflicts with permissive licensing; real personal data / ethical concerns |

## What lands, and how

Only the **INCLUDE** rows are imported, and only their *prompts* (not Moonshot's LLM-judge metrics).
Because Moonshot jailbreak/injection prompts are generic, they are applied as **techniques over this
product's own marker-bearing seeds** (like a PyRIT converter): the seed supplies the objective +
marker (so the existing objective→checks scoring holds), the Moonshot prompt supplies the
wrapper/technique (DAN persona-override, multilingual injection framing). Every imported prompt is
MinHash-deduplicated against the existing seeds and PyRIT variants; a prompt that adds no new
technique/language is dropped ("extra tests only").

Attribution: MIT requires the licence + copyright notice be carried. The importer writes each
source's `LICENSE`/`NOTICE` alongside the staged output; this manifest records the provenance.
