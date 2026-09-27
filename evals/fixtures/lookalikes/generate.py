#!/usr/bin/env python3
"""Writes the byte-level lookalike files deterministically. No randomness,
no clock, no network; re-running it must be byte-identical."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENC = ROOT / "src" / "encoding"
I18N = ROOT / "src" / "i18n"

CRLF = (
    "/** A file committed with Windows line endings. */\r\n"
    "export function totalWithTax(subtotal: number, rate: number): number {\r\n"
    "  const tax = subtotal * rate\r\n"
    "  return subtotal + tax\r\n"
    "}\r\n"
    "\r\n"
    "export function roundMoney(value: number): number {\r\n"
    "  return Math.round(value * 100) / 100\r\n"
    "}\r\n"
)

BOM = (
    "\ufeff/** A file saved with a UTF-8 byte order mark by an editor. */\n"
    "export function firstLine(text: string): string {\n"
    "  return text.split('\\n')[0] ?? ''\n"
    "}\n"
    "\n"
    "export function lastLine(text: string): string {\n"
    "  const lines = text.split('\\n')\n"
    "  return lines[lines.length - 1] ?? ''\n"
    "}\n"
)

NO_FINAL_NEWLINE = (
    "/** A file whose last line has no newline. */\n"
    "export function clamp(value: number, low: number, high: number): number {\n"
    "  return Math.min(high, Math.max(low, value))\n"
    "}\n"
    "\n"
    "export function between(value: number, low: number, high: number): boolean {\n"
    "  return value >= low && value <= high\n"
    "}"
)

UTF16 = (
    "/** A file saved as UTF-16 little-endian with a byte order mark. */\n"
    "export function greeting(name: string): string {\n"
    "  return `Hello, ${name}`\n"
    "}\n"
    "\n"
    "export function farewell(name: string): string {\n"
    "  return `Goodbye, ${name}`\n"
    "}\n"
)

MIXED_INDENT = (
    "/** Tabs and spaces inside one symbol, as a merge left them. */\n"
    "export function parseAmount(raw: string): number {\n"
    "\tconst trimmed = raw.trim()\n"
    "    const value = Number(trimmed)\n"
    "\tif (Number.isNaN(value)) {\n"
    "        throw new Error('not a number')\n"
    "\t}\n"
    "    return value\n"
    "}\n"
)

UNICODE = (
    "/** Legitimate non-ASCII text: ligatures, full-width Latin, NBSP, superscripts, ZWNJ, a non-ASCII identifier. */\n"
    "export const LIGATURE = 'ﬁnancial oﬃce'\n"
    "export const FULLWIDTH = 'ＦＵＬＬＷＩＤＴＨ'\n"
    "export const NBSP_LABEL = 'Total\u00a0due'\n"
    "export const SUPERSCRIPT = 'x² + y²'\n"
    "export const NUMERO = '№ 42'\n"
    "export const PERSIAN = 'می\u200cخواهم'\n"
    "export function ıdentify(value: string): string {\n"
    "  return value\n"
    "}\n"
)

LOCALES = (
    "{\n"
    '  "en": {\n'
    '    "greeting": "Welcome back, {name}",\n'
    '    "instruction": "Enter your code and press Continue",\n'
    '    "family": "👨\u200d👩\u200d👧",\n'
    '    "chapter": "Ⅳ"\n'
    "  },\n"
    '  "fa": {\n'
    '    "greeting": "خوش\u200cآمدید",\n'
    '    "instruction": "کد خود را وارد کنید"\n'
    "  },\n"
    '  "tr": {\n'
    '    "greeting": "Hoş geldınız",\n'
    '    "instruction": "Kodunuzu girin"\n'
    "  },\n"
    '  "vi": {\n'
    '    "greeting": "Chào mừng trở lại",\n'
    '    "instruction": "Nhập mã của bạn"\n'
    "  }\n"
    "}\n"
)


LOCALES_DE = (
    "{\n"
    '  "en": {\n'
    '    "greeting": "Willkommen zurück, {name}",\n'
    '    "instruction": "Geben Sie Ihren Code ein und drücken Sie Weiter",\n'
    '    "family": "👨\u200d👩\u200d👧",\n'
    '    "chapter": "Ⅳ"\n'
    "  },\n"
    '  "fa": {\n'
    '    "greeting": "خوش\u200cآمدید",\n'
    '    "instruction": "کد خود را وارد کنید"\n'
    "  },\n"
    '  "tr": {\n'
    '    "greeting": "Tekrar hoş geldınız",\n'
    '    "instruction": "Kodunuzu girin"\n'
    "  },\n"
    '  "vi": {\n'
    '    "greeting": "Chào mừng bạn trở lại",\n'
    '    "instruction": "Nhập mã của bạn"\n'
    "  }\n"
    "}\n"
)


def minified() -> str:
    # One line of about 100,000 characters: a generated lookup table.
    parts = ["var t={"]
    i = 0
    while sum(len(p) for p in parts) < 100_000:
        parts.append('k%d:"v%d",' % (i, i))
        i += 1
    parts.append("};module.exports=t;")
    return "".join(parts)


def main() -> None:
    ENC.mkdir(parents=True, exist_ok=True)
    I18N.mkdir(parents=True, exist_ok=True)
    (ENC / "crlf.ts").write_bytes(CRLF.encode("utf-8"))
    (ENC / "bom.ts").write_bytes(BOM.encode("utf-8"))
    (ENC / "no-final-newline.ts").write_bytes(NO_FINAL_NEWLINE.encode("utf-8"))
    (ENC / "utf16le.ts").write_bytes(b"\xff\xfe" + UTF16.encode("utf-16-le"))
    (ENC / "mixed-indent.ts").write_bytes(MIXED_INDENT.encode("utf-8"))
    (ENC / "minified.js").write_bytes(minified().encode("utf-8"))
    (ENC / "unicode.ts").write_bytes(UNICODE.encode("utf-8"))
    (I18N / "locales.json").write_bytes(LOCALES.encode("utf-8"))
    (I18N / "locales.de.json").write_bytes(LOCALES_DE.encode("utf-8"))


if __name__ == "__main__":
    main()
