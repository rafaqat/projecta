import type { CallStatus, Usage } from '#app/audit/ledger'

/**
 * What a model call cost, as span attributes on the round that made it.
 *
 * The counts come from the provider and exist only inside the SDK adapter (INV-01); this turns them
 * into keys the allowlists declare. Two of those keys had been declared and written by nothing since
 * they were added, and the dead-key guard reported clean throughout because it only checked the
 * `app.` namespace — widened in the same change that adds this.
 *
 * The names follow the OpenTelemetry generative-AI conventions rather than `app.`, so a reader who
 * knows the convention finds them where they expect and a future instrumentation would populate
 * these keys rather than a second set.
 *
 * Structural under ADR-0025: integers and a boolean from the provider, no free text, exported in
 * every environment.
 *
 * The cache counts are not optional decoration. This client enables prompt caching with two
 * breakpoints (`withEvidenceCache`), and the provider reports cached tokens *separately* from
 * `input_tokens` rather than inside it — so a well-cached round shows a small input count, and
 * without these two keys that reads as the prompt having shrunk instead of having been reused.
 */
export const USAGE_ATTRIBUTE_KEYS = [
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.cache_read_input_tokens',
  'gen_ai.usage.cache_creation_input_tokens',
  'gen_ai.usage.complete',
] as const

export type UsageAttributes = {
  'gen_ai.usage.input_tokens'?: number
  'gen_ai.usage.output_tokens'?: number
  'gen_ai.usage.cache_read_input_tokens'?: number
  'gen_ai.usage.cache_creation_input_tokens'?: number
  'gen_ai.usage.complete': boolean
}

/**
 * A count is written when the provider reported it and omitted when it did not.
 *
 * A completed call reports all four. A call that failed or was cancelled mid-stream reports the input
 * tokens it learned at `message_start` and knows nothing about its output, because `finalMessage()`
 * never returned: `outputTokens` is `undefined`, not `0`.
 *
 * Writing `0` there would keep every `sum()` arithmetically right while asserting the call produced
 * no output, when what is true is that nobody found out. Omitting it says "not known" honestly, but
 * an absent series is indistinguishable from a free one in an aggregate — so `gen_ai.usage.complete`
 * is written unconditionally and carries that distinction explicitly. A panel summing output tokens
 * undercounts, and the `complete=false` series beside it says by how many rounds.
 *
 * Spend is reconciled from the ledger's own rows, not from these attributes, so this governs what a
 * dashboard claims rather than what anyone is charged.
 */
export function usageAttributes(usage: Usage, status: CallStatus): UsageAttributes {
  const attributes: UsageAttributes = { 'gen_ai.usage.complete': status === 'completed' }
  if (usage.inputTokens !== undefined) attributes['gen_ai.usage.input_tokens'] = usage.inputTokens
  if (usage.outputTokens !== undefined)
    attributes['gen_ai.usage.output_tokens'] = usage.outputTokens
  if (usage.cacheReadTokens !== undefined)
    attributes['gen_ai.usage.cache_read_input_tokens'] = usage.cacheReadTokens
  if (usage.cacheCreationTokens !== undefined)
    attributes['gen_ai.usage.cache_creation_input_tokens'] = usage.cacheCreationTokens
  return attributes
}
