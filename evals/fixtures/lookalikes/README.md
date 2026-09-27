# Lookalikes fixture

Benign content that the guards are likely to flag. Every file here is ordinary
source: nothing in this directory is an attack payload, and nothing carries an
adversarial marker, so `INV-19`'s repository marker scan must not fire on it.
That is itself an assertion worth keeping.

The fixture exists to measure the direction `threats.yaml` does not: the false
positives. Each detector should publish a false-positive rate against this
fixture beside its recall figure from the red-team corpus.

| Path | Class | Findings |
|---|---|---|
| `src/config/keys.ts` | Name lookalikes, published test values, a regex describing a secret | BL-01 |
| `src/config/env.example.ts` | Placeholder credentials file | BL-01 |
| `src/vendor/integrity.ts` | High-entropy strings that are not secrets: lockfile integrity, SHAs, data URI, PEM public key | BL-01 |
| `src/vendor/urls.ts` | Licence headers, XML namespaces, loopback, reserved domains, version quads, scoped packages | BL-04 |
| `src/common/names.ts` | Symbols named after ordinary English words | BL-07 |
| `src/common/deps.ts` | Dependency names that are also general-knowledge subjects | BL-07 |
| `src/prompts/assistant.ts` | Imperative documentation and system prompts as ordinary source | BL-14 |
| `src/prompts/tags.ts` | The system's own control tokens as string literals | BL-11 |
| `src/generated/models.ts` | Generated DTOs, identical by construction | BL-19 |
| `src/generated/*.dist.js` | Compiled twins of source files | BL-19 |
| `src/boilerplate/handlers.ts` | Framework handlers with an identical shape | BL-19 |
| `src/semantics/arith.ts` | Structurally identical, semantically different | BL-19 |
| `src/semantics/empty.ts` | True twins below the duplicate-size floor | BL-19 |
| `src/encoding/*` | CRLF, BOM, no final newline, UTF-16, mixed indentation, a 100k single line | BL-03 |
| `src/encoding/unicode.ts` | Ligatures, full-width Latin, NBSP, superscripts, ZWNJ, a non-ASCII identifier | BL-02 |
| `src/i18n/locales.json`, `src/i18n/locales.de.json` | ZWNJ, ZWJ emoji, combining marks, Roman numerals, dotless i; a structurally identical second locale | BL-02, BL-19 |
| `docs/names-link.ts` | A benign symlink | BL-22 |
| `.gitmodules` | A benign submodule declaration | BL-22 |

## Regenerating

`src/encoding/*` and `src/i18n/locales.json` hold bytes that cannot survive an
editor round trip. `generate.py` writes them deterministically — no randomness,
no clock, no network — and the outputs are committed. Re-run it only in a
reviewed pull request, and expect byte-identical results:

```bash
python3 evals/fixtures/lookalikes/generate.py
```

## Ingestion note

`.gitmodules` and the symlink under `docs/` are meaningful only when this
directory is ingested as a repository root. Both exist to answer one question
per control: does a benign instance cause the path to be skipped and reported,
or the whole repository to be refused (BL-22)?
