"""PyRIT converter variants (design §12 stage 3b), run with `uv run pyrit_variants.py`.

Reads the encoded seeds, applies PyRIT converters (Base64, Unicode confusables, ROT13,
character spacing) and writes evals/redteam/generated/pyrit-variants.json with every
payload base64-encoded (ADR-013). Some converters are randomised, so the output is frozen
and reviewed by a person before any variant becomes a regression case.
"""
import base64
import json
import pathlib

from pyrit.prompt_converter import Base64Converter, CharacterSpaceConverter, ROT13Converter, UnicodeConfusableConverter

ROOT = pathlib.Path(__file__).resolve().parents[1]
SEEDS = json.loads((ROOT / "seeds.json").read_text())["seeds"]
CONVERTERS = {
    "pyrit_base64": Base64Converter(),
    "pyrit_confusable": UnicodeConfusableConverter(),
    "pyrit_rot13": ROT13Converter(),
    "pyrit_spacing": CharacterSpaceConverter(),
}


def encode(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


async def main() -> None:
    variants = []
    for seed in SEEDS:
        text = base64.b64decode(seed["text_b64"]).decode()
        for name, converter in CONVERTERS.items():
            result = await converter.convert_async(prompt=text)
            variants.append({
                "id": f"{seed['id']}--{name}",
                "seed": seed["id"],
                "technique": name,
                "objective": seed["objective"],
                "threats": seed["threats"],
                "marker_b64": seed["marker_b64"],
                "text_b64": encode(result.output_text),
                "provenance": {"source": "pyrit", "converter": type(converter).__name__},
            })
    out = ROOT / "generated" / "pyrit-variants.json"
    out.write_text(json.dumps({"encoding": "base64", "variants": variants}, indent=2) + "\n")
    print(f"{len(variants)} PyRIT variants written to {out}")


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
