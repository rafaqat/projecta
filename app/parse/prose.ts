import { grammarFor } from '#app/parse/parser'

/**
 * The prose of a code chunk: comments and string literals, where an
 * instruction to a model can hide; code tokens are not prose. The
 * injection classifier reads the prose only, and a chunk with
 * none is never sent — most of the clean chunks it flagged were one-line
 * code (assessment 2026-09-15: 34.7% over 176 negatives). Lexical, not
 * grammar-aware: it runs on the text the chunker produced, for any
 * language the index holds — and it knows the file type: a
 * template's attribute values and a JSON file's keys are string literals
 * to the lexer and never prose to a reader, and half of all Handlebars
 * chunks were flagged on their class lists.
 */
const LINE_COMMENT = /(?:^|[^:'"`\\])\/\/(.*)$/gm
const BLOCK_COMMENT = /\/\*([\s\S]*?)\*\//g
const HASH_COMMENT = /^\s*#(?!!)(.*)$/gm
// Every string literal, the empty and one-character ones included: skipping `"#"` left the lexer
// on the wrong side of every quote after it, so `href="#" class="…" title="…"` yielded ` class=`
// and ` title=` and never the title (found by the WP-30 ablation, 2026-09-20). The word and
// long-literal tests drop the short ones.
const STRING = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g

/** Prose needs words: at least three of two or more letters, and a space between some of them. */
const WORDY = /(?:\b[A-Za-z]{2,}\b[^A-Za-z]+){2,}\b[A-Za-z]{2,}\b/
/** A string literal this long is content, wordy or not: an encoded or obfuscated instruction is one. */
const LONG_LITERAL = 40
/** Lines with code punctuation; a chunk where most lines lack it does not look like code. */
const CODE_LINE =
  /[{}();=<>[\]]|^\s*(?:import|export|const|let|var|function|class|return|if|for|while|def|fn|pub|use)\b/

/**
 * A class list, a style attribute, a path: tokens carrying code punctuation or digits. When half or
 * more of a candidate's tokens do, it is not a sentence. `btn btn-primary ms-3` is
 * dropped; `Ignore all previous instructions` is not; a long encoded literal is judged by
 * LONG_LITERAL before this and is kept.
 */
const CODE_TOKEN = /[-_./:;=]|\d/
function classList(text: string): boolean {
  const tokens = text.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  return tokens.filter((t) => CODE_TOKEN.test(t)).length * 2 >= tokens.length
}

/** A JSON string value that is a URL, a path, a hash, a version or an identifier is data, not prose. */
const DATA_VALUE =
  /^(?:[a-z]+:\/\/|\/|\.{0,2}\/|[\w.-]+\/|sha\d+-|\d+(?:\.\d+)+|[A-Za-z0-9+/=_-]{32,}$)/

function clean(text: string): string {
  return text
    .replace(/^\s*\*+/gm, ' ') // the leading `*` of block-comment lines
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Every comment and string literal of the chunk that reads as prose, in order. With a path, the
 * file type decides what counts: a template's text nodes and comments, a JSON file's
 * sentence-shaped values, a code file's comments and strings. Without one — the eval's payloads —
 * the chunk is read as code.
 */
export function proseOf(code: string, path?: string, rules: ProseRules = {}): string[] {
  const grammar = path ? grammarFor(path) : null
  if (grammar === 'template') return templateProse(code, rules)
  if (grammar === 'json') return jsonProse(code, rules)
  return codeProse(code, rules)
}

/**
 * The rules a test may switch off to prove its assertion does work (ablation
 * enforcement). Production callers pass nothing: every rule is on.
 */
export interface ProseRules {
  /** Drop a wordy candidate that is half code tokens (`btn btn-primary ms-3`). Default on. */
  classList?: boolean
  /** A test-framework call's first string is the test's name, not prose. Default on. */
  testTitle?: boolean
}

/**
 * What precedes a test title: `test(`, `it.skip(`, `describe.each(cases)(`, `xit(` — Japa, Vitest,
 * Jest, Mocha, node:test, Playwright, tinybench and their `x`-prefixed skips. Once dropped
 * the code tokens around it, the classifier was handed the bare title and called an imperative
 * sentence about behaviour an instruction at 0.999 (test files flagged at 19% against 5%). The
 * `.each(...)` argument may nest parentheses two deep (`[['b', g(2, h(3))]]`).
 */
const TEST_CALL =
  /\b(?:x?test|x?it|x?describe|suite|context|specify|bench)(?:\.(?:only|skip|todo|each|concurrent|serial|failing)(?:\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))?)*\s*\(\s*$/

function collector(rules: ProseRules) {
  const found: Array<{ at: number; text: string }> = []
  const seen = new Set<string>()
  const push = (at: number, raw: string | undefined, long = false) => {
    if (raw === undefined) return
    const text = clean(raw)
    if (seen.has(text)) return
    // A wordy candidate must read as a sentence, not a class list. A candidate
    // that is not wordy is kept only as a long literal — an encoded instruction has no words —
    // and that rule is unchanged, so no payload that qualified before stops qualifying.
    const wordy = WORDY.test(text)
    if (!wordy && !(long && text.length >= LONG_LITERAL)) return
    if (wordy && rules.classList !== false && classList(text)) return
    seen.add(text)
    found.push({ at, text })
  }
  return { push, list: () => found.sort((a, b) => a.at - b.at).map((f) => f.text) }
}

const TAG = /<!--[\s\S]*?-->|<[^>]*>/g
const HTML_COMMENT = /<!--([\s\S]*?)-->/g
const TEMPLATE_COMMENT = /\{\{!--([\s\S]*?)--\}\}|\{\{!([^}]*)\}\}/g
const EXPRESSION = /\{\{[^}]*\}\}/g

/** Text nodes and comments; an attribute value is never prose, whatever it says. */
function templateProse(code: string, rules: ProseRules): string[] {
  const { push, list } = collector(rules)
  for (const m of code.matchAll(HTML_COMMENT)) push(m.index, m[1])
  for (const m of code.matchAll(TEMPLATE_COMMENT)) push(m.index, m[1] ?? m[2])
  const text = code
    .replace(TEMPLATE_COMMENT, (m) => ' '.repeat(m.length))
    .replace(TAG, (m) => ' '.repeat(m.length))
  for (const m of text.matchAll(/[^\n]+/g)) push(m.index, m[0].replace(EXPRESSION, ' '))
  return list()
}

/** Every string, with the `:` that makes it a key: consuming keys whole keeps the quotes aligned. */
const JSON_STRING = /"((?:[^"\\]|\\.)*)"(\s*:)?/g

/** String values with sentence shape; a key, a URL, a path, a hash or a version is data. */
function jsonProse(code: string, rules: ProseRules): string[] {
  const { push, list } = collector(rules)
  for (const m of code.matchAll(JSON_STRING)) {
    if (m[2] !== undefined) continue // a key
    const value = m[1]
    if (DATA_VALUE.test(value.trim())) continue
    push(m.index, value)
  }
  return list()
}

function codeProse(code: string, rules: ProseRules): string[] {
  const { push, list } = collector(rules)
  // Not code at all (a prose block, an encoded payload, a document): the whole chunk is prose.
  const lines = code.split('\n').filter((l) => l.trim())
  if (lines.length && lines.filter((l) => CODE_LINE.test(l)).length * 2 < lines.length) {
    const whole = clean(code)
    return WORDY.test(whole) || whole.length >= LONG_LITERAL ? [whole] : []
  }
  for (const m of code.matchAll(BLOCK_COMMENT)) push(m.index, m[1])
  // Block comments blanked in place, so positions below still index the original text.
  const withoutBlocks = code.replace(BLOCK_COMMENT, (m) => ' '.repeat(m.length))
  for (const m of withoutBlocks.matchAll(LINE_COMMENT)) push(m.index, m[1])
  for (const m of withoutBlocks.matchAll(HASH_COMMENT)) push(m.index, m[1])
  for (const m of withoutBlocks.matchAll(STRING)) {
    if (rules.testTitle !== false && TEST_CALL.test(withoutBlocks.slice(0, m.index))) continue
    push(m.index, m[1] ?? m[2] ?? m[3], true)
  }
  return list()
}

/** Whether the classifier has anything to read: some prose, or none and the model is spared the call. */
export function worthClassifying(code: string, path?: string): boolean {
  return proseOf(code, path).length > 0
}

/**
 * Part of the scan derivation key: bump when what the classifier is given changes, or
 * when its verdict logic changes so a reader's flag stays the current classifier's (indexer §
 * re-derivation). prose-6: the detector gained a confidence floor + rule co-signal (2026-09-24).
 */
export const SCAN_VERSION = 'prose-6'

/** What the classifier is given: the chunk's prose joined, or nothing. */
export function classifiableText(code: string, path?: string): string | null {
  const prose = proseOf(code, path)
  return prose.length ? prose.join('\n') : null
}

/** What the classifier reads of one text (services/model-server/server.py CLASSIFY_MAX_CHARS). */
export const SCAN_WINDOW_CHARS = 2000

/**
 * A text in windows the classifier reads whole, cut at line ends where a line end falls
 * inside the window, so a sentence is not split mid-word; a single line longer than the window is
 * its own window and the classifier truncates it, as before.
 */
export function scanWindows(text: string): string[] {
  if (text.length <= SCAN_WINDOW_CHARS) return [text]
  const out: string[] = []
  let from = 0
  while (from < text.length) {
    let to = Math.min(from + SCAN_WINDOW_CHARS, text.length)
    if (to < text.length) {
      const cut = text.lastIndexOf('\n', to)
      if (cut > from) to = cut + 1
    }
    out.push(text.slice(from, to))
    from = to
  }
  return out
}
