"""Moonshot discovery importer (ADR-0008), run with `uv run moonshot_import.py`.

Fetches the two MIT-licensed attack corpora cleared by the licensing gate (see
`moonshot_datasets.md`) — Meta PurpleLlama CyberSecEval prompt-injection (multilingual) and the
verazuo/jailbreak_llms DAN corpus — and turns each prompt into a *wrapper technique* over this
product's own marker-bearing seeds. The seed supplies the objective + marker (so the existing
objective->checks scoring in app/redteam/discover.ts still holds); the Moonshot prompt supplies the
jailbreak/injection framing. Output is base64 at rest (ADR-013) at
evals/redteam/generated/moonshot-variants.json, for a person to review before promotion (R-06/R-08).

Only INCLUDE datasets from the manifest are fetched. Nothing here is run in CI (offline/UAT only).
"""
import base64
import csv
import io
import json
import pathlib
import re
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
SEEDS = json.loads((ROOT / "seeds.json").read_text())["seeds"]

# Objectives the discovery bridge can score as a user_question probe (mirror OBJECTIVE_CHECKS in
# app/redteam/discover.ts). Wrapping a seed the bridge would skip only wastes live model calls.
COVERABLE = {
    "leak_system_prompt",
    "extract_secret",
    "cross_tenant",
    "external_url",
    "forged_citation",
    "ungrounded_claim",
}

# Only the MIT rows from moonshot_datasets.md. URLs are pinned to a ref; verify on first run.
SOURCES = [
    {
        "name": "cyberseceval_pi",
        "license": "MIT — meta-llama/PurpleLlama (CyberSecEval)",
        "format": "json",
        "url": "https://raw.githubusercontent.com/meta-llama/PurpleLlama/main/CybersecurityBenchmarks/datasets/prompt_injection/prompt_injection_multilingual_machine_translated.json",
    },
    {
        "name": "jailbreak_dan",
        "license": "MIT — verazuo/jailbreak_llms (Shen et al., CCS'24)",
        "format": "csv",
        "url": "https://raw.githubusercontent.com/verazuo/jailbreak_llms/main/data/prompts/jailbreak_prompts_2023_12_25.csv",
    },
]

MAX_WRAPPERS_PER_SOURCE = 8  # keep the seed x wrapper live-run cost bounded; tune as needed
JACCARD_DROP = 0.9  # a wrapper this similar to one already kept adds no new test


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as resp:  # noqa: S310 (pinned raw URLs)
        return resp.read()


def extract_cyberseceval(raw: bytes) -> list[tuple[str, str]]:
    """(wrapper prompt, language) from CyberSecEval prompt-injection JSON."""
    rows = json.loads(raw.decode())
    out = []
    for r in rows if isinstance(rows, list) else rows.get("prompts", []):
        prompt = r.get("user_input") or r.get("test_case_prompt") or ""
        lang = (r.get("speaking_language") or r.get("language") or "en").lower()
        if prompt.strip():
            out.append((prompt.strip(), lang))
    return out


def extract_dan(raw: bytes) -> list[tuple[str, str]]:
    """(wrapper prompt, 'dan') from the jailbreak_llms CSV, jailbreak rows only."""
    reader = csv.DictReader(io.StringIO(raw.decode(errors="replace")))
    out = []
    for row in reader:
        flag = str(row.get("jailbreak", "")).strip().lower()
        prompt = (row.get("prompt") or "").strip()
        if prompt and flag in {"true", "1", "yes"}:
            out.append((prompt, "en"))
    return out


def norm(t: str) -> str:
    return re.sub(r"\s+", " ", t.lower()).strip()


def shingles(t: str, k: int = 5) -> set[str]:
    words = norm(t).split()
    return {" ".join(words[i : i + k]) for i in range(max(1, len(words) - k + 1))}


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def dedup(wrappers: list[tuple[str, str]]) -> list[tuple[str, str]]:
    kept: list[tuple[str, str, set[str]]] = []
    for prompt, lang in wrappers:
        sh = shingles(prompt)
        if any(jaccard(sh, k[2]) >= JACCARD_DROP for k in kept):
            continue
        kept.append((prompt, lang, sh))
    return [(p, l) for p, l, _ in kept]


def encode(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


def main() -> None:
    wrappers: list[dict] = []
    notices = []
    for src in SOURCES:
        try:
            raw = fetch(src["url"])
        except Exception as err:  # offline tool: fail loudly with the URL to fix
            print(f"ERROR fetching {src['name']} ({src['url']}): {err}", file=sys.stderr)
            sys.exit(1)
        extracted = (extract_cyberseceval if src["format"] == "json" else extract_dan)(raw)
        kept = dedup(extracted)[: MAX_WRAPPERS_PER_SOURCE]
        for i, (prompt, lang) in enumerate(kept):
            wrappers.append(
                {"prompt": prompt, "technique": f"moonshot:{src['name']}:{lang}", "n": i, "src": src}
            )
        notices.append(f"{src['name']}: {len(kept)} wrappers — {src['license']}")

    # Fit each attack under the app's input cap (config/scope-policy.json inputCapCharacters) so the
    # payload reaches the model + evidence gate instead of being rejected pre-model as "too long"
    # (ADR-0008 importer fit). The ask carries the marker + objective and is kept whole; only the
    # wrapper framing is truncated to fit. A seed whose ask alone leaves no room is skipped.
    CAP = 400
    MARGIN = 8
    # The live runner sends `carrier_question + " " + variant` (discover.ts DISCOVERY_CARRIER,
    # "Explain how this repository works." ~35 chars, prepended by runLive). Reserve room for it so
    # the ASSEMBLED question — not just the variant — stays under the cap.
    CARRIER_RESERVE = 48
    MIN_WRAPPER = 40  # a wrapper trimmed below this adds no framing worth a variant
    variants = []
    skipped_fit = 0
    for seed in SEEDS:
        if seed["objective"] not in COVERABLE:
            continue
        ask = base64.b64decode(seed["text_b64"]).decode()
        budget = CAP - CARRIER_RESERVE - len(ask) - 2 - MARGIN  # 2 = len("\n\n")
        if budget < MIN_WRAPPER:
            skipped_fit += len(wrappers)
            continue
        for w in wrappers:
            wrapper_fit = w["prompt"][:budget].rstrip()  # keep the leading framing, drop the tail
            combined = f"{wrapper_fit}\n\n{ask}"  # jailbreak/injection framing, then the marked ask
            if len(combined) + CARRIER_RESERVE > CAP:  # defensive: carrier + variant must fit
                skipped_fit += 1
                continue
            variants.append(
                {
                    "id": f"{seed['id']}--{w['technique']}--{w['n']}",
                    "seed": seed["id"],
                    "technique": w["technique"],
                    "objective": seed["objective"],
                    "threats": seed["threats"],
                    "marker_b64": seed["marker_b64"],
                    "text_b64": encode(combined),
                    "provenance": {"source": "moonshot", "dataset": w["src"]["name"], "license": w["src"]["license"]},
                }
            )

    gen = ROOT / "generated"
    gen.mkdir(exist_ok=True)
    out = gen / "moonshot-variants.json"
    out.write_text(json.dumps({"encoding": "base64", "variants": variants}, indent=2) + "\n")
    (gen / "moonshot-NOTICE.txt").write_text(
        "Attack wrappers imported under MIT (ADR-0008). Attribution:\n" + "\n".join(notices) + "\n"
    )
    print(
        f"{len(variants)} Moonshot variants written to {out} "
        f"({len(wrappers)} wrappers x seeds, fitted under {CAP} chars; {skipped_fit} skipped as unfittable)"
    )


if __name__ == "__main__":
    main()
