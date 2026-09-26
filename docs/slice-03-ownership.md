# Slice 3 (cited answers) — cross-slice ownership map

Slice 3 owns retrieval, the evidence gate, the agent loop and LLM access. Its
import closure overlaps files already committed on Slice 2 and Slice 4. Those
files are present in this branch **only because typecheck needs them**; they are
not Slice 3's to own. Dedupe at merge (keep the already-committed slice's copy).

## Genuinely Slice 3 (own here)

| Path | Notes |
|---|---|
| `app/assistant/**` | Agent loop, evidence gate, answer layout, verification, turn service, protocol, in_process, tools, prompts/*.md, sse |
| `app/retrieval/**` | Hybrid RRF fusion, search, search_text, rerank, router, locate, outline, repo_map, evidence_pack, scope_classifier, etc. |
| `app/llm/client.ts` | The only `@anthropic-ai/sdk` importer; points at the gateway via `ANTHROPIC_BASE_URL` + `LLM_GATEWAY_TOKEN` |
| `app/security/attribution.ts`, `commitment.ts`, `derivation_keys.ts` | Attribution token + commitments (derivation_keys is their dep) |
| `app/controllers/turns_controller.ts`, `decisions_controller.ts` | HTTP edge — **excluded from tsconfig** (needs Slice 1 guard/bouncer chain; see below) |
| `app/validators/turn.ts` | Turn request validator |
| `app/assets_version.ts` | Asset-version header helper used by the turn route (may be shared with a UI slice) |

## Belongs to Slice 2 (ingest) — dedupe at merge, no migration re-created

| Path | Pulled in by |
|---|---|
| `app/ingest/{git_runner,indexer,object_reader,peak_memory,secret_redaction}.ts` | `retrieval/exclusions` → object_reader; `assistant/tools` → indexer |
| `app/parse/**` (23 files incl. `profiles/**`, `extractors/endpoints`) | `retrieval/hybrid`+`search` → embedder; `retrieval/exclusions` → parser; `assistant/tools` → child_process; `assistant/in_process` → injection |
| `app/clones/{alignment,detector,minhash,queries,tokens}.ts` | `assistant/tools` → clones/queries |
| `app/dependencies/{extractor,gradle_catalog,manifests,surface,tar,tier1}.ts` | `assistant/tools` → dependencies/tier1 |

## Belongs to Slice 4 (gateway/audit/cost) — dedupe at merge, no migration re-created

| Path | Pulled in by |
|---|---|
| `app/audit/{config_hash,decision_record,ledger}.ts` | `assistant/turn_service` → decision_record/recordTurn; `llm/client` → ledger + config_hash |
| `app/cost/turn_cost.ts` | `controllers/turns_controller` |
| `packages/cost/src/prices.ts` (+ package.json) | `app/cost/turn_cost` (`#cost/*`) |
| `packages/guards/src/**` (7 files, + package.json) | `llm/client` + `audit/decision_record` (`#guards/*`) |

## Migrations

| Table(s) | Created by | Owner |
|---|---|---|
| `threads`, `turns` | `create_threads` | Slice 4 |
| `turn_citations` (+ `turns` alters) | `create_audit_tables` | Slice 4 |
| `chunks`, `commits`, `symbols`, `citation_blocks`, `files`, `blobs`, `repo_facts`, `honeytokens`, `symbol_references`, `endpoints` | `create_index_tables` / `create_ingestion_tables` | Slice 2 |
| `manifests`, `dependencies`, `dependency_symbols` | `create_dependency_tables` | Slice 2 |

**Slice 3 adds zero migrations** — every table its code reads or writes is owned by Slice 2 or Slice 4.

## Runtime dependencies added (dedupe at merge)

| Package | Version | Owner |
|---|---|---|
| `@anthropic-ai/sdk` | 0.125.0 | Slice 3 |
| `web-tree-sitter` | 0.27.0 | Slice 2 |
| `@vscode/tree-sitter-wasm` | 0.3.1 | Slice 2 |
| `@huggingface/transformers` | 4.2.0 | Slice 2 |
| `re2` | 1.26.1 | Slice 2 |
| `canonicalize` | ^5.0.0 | Slice 4 (also used by Slice 3 attribution) |

## Trims applied (to match Slice 1's no-OpenTelemetry posture)

| File | Trim |
|---|---|
| `app/retrieval/router.ts` | Dropped `@opentelemetry/api`; `recordScopeDecision` is a no-op |
| `app/audit/decision_record.ts` (Slice 4) | Dropped `@opentelemetry/api`; `trace_id`/`traceId` written as null/'' |
| `app/assistant/turn_service.ts` | Dropped `appMetrics` (telemetry/metrics) calls |
| `app/security/telemetry/{metrics,log_records}.ts` | Not ported (unreferenced after the trims; Slice 1 telemetry) |
