import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Versioned prompt files (design §6). The system prompt is static, lives in
 * the repository and is hashed into configHash; call sites never build
 * prompt text from strings.
 */
export interface PromptFile {
  id: string
  version: number
  text: string
  sha256: string
}

const here = fileURLToPath(new URL('.', import.meta.url))

function load(name: string, version: number): PromptFile {
  const text = readFileSync(`${here}${name}.v${version}.md`, 'utf8')
  return { id: name, version, text, sha256: createHash('sha256').update(text).digest('hex') }
}

// v7: for a feature-flow question naming no symbol, the model locates the feature then traces from
// a symbol locate returns, so the flow is shown (B1 fine-tune; views:eval trace gap,
// owner 2026-09-18).
// v6: a "Choosing a view" section guides the model to call the tool whose structured view fits
// the question, so view selection is guided by the prompt rather than only the router's regex
// pre-runs (option B / B1, owner 2026-09-18).
// v5: explanations come from code in evidence, never from a name or a signature, and a table's
// rows are described only from their own code (owner 2026-09-16).
// v4: <no_instance/> gives the model a positive move when a concept has no instance in the code
// (owner review 2026-09-14); v3 anchored general questions in the code; v2 is the owner-reviewed
// wording of 2026-09-12; v1 is kept for the record. The hash is part of configHash.
export const PROMPTS = {
  system: load('system', 7),
} as const
