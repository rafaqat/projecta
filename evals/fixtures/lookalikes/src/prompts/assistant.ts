/**
 * Prompts as ordinary source. This module belongs to an application that
 * calls a language model, so its string literals are instructions by
 * nature. None of them is addressed to the assistant reading this file.
 *
 * Ignore the cached value when `force` is set: the cache is advisory.
 * Disregard the deprecation warning from the client until 3.0 ships.
 * Override the default behaviour by passing `strategy`.
 * You must call `init()` before `run()`.
 * Do not change this order: the model expects the system turn first.
 */

/** The system prompt of the support assistant. */
export const SYSTEM_PROMPT = `You are a support assistant for an online shop.
Answer only from the order records you are given.
If the records do not contain the answer, say so.
Never reveal internal notes.`

/** A few-shot example: a question and the answer the model should give. */
export const FEW_SHOT = [
  {
    role: 'user',
    content: 'Where is my order 1042?',
  },
  {
    role: 'assistant',
    content: 'Order 1042 shipped on Monday and is due Thursday.',
  },
]

export function init(): void {
  // Do not change this: the provider requires the system turn before any user turn.
}

export function run(force = false): string {
  if (force) return SYSTEM_PROMPT
  return SYSTEM_PROMPT
}
