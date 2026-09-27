/**
 * Mitigation ablations for the adversarial and tenancy suites ( *). This module exists only in test image targets; production boot
 * refuses any ABLATION_* variable and the module is pruned from the image.
 */
export const ABLATIONS = [
  'no_app_scope_checks',
  'no_workspace_filter',
  'fail_open_on_policy_error',
  'no_scope_rules',
  'no_scope_classifier',
  'no_output_gate',
  // WP-10: one flag per mitigation the red-team runner can remove (evals/redteam/ablations.json).
  'no_hold_back_rules',
  'no_system_prompt_canary_rule',
  'no_secret_rules',
  'no_secret_redaction',
  'no_honeytoken_rule',
  'no_gateway_url_rule',
  'no_text_normalisation',
  'no_entity_verifier',
  'no_hydration_rejects_unknown',
  'no_iteration_cap',
  'no_turn_deadline',
  'no_diversity_caps',
  'no_sufficiency_gate',
  'no_quoted_comment_rule',
] as const

export type Ablation = (typeof ABLATIONS)[number]

export function activeAblations(): Set<Ablation> {
  const active = new Set<Ablation>()
  for (const name of ABLATIONS) {
    if (process.env[`ABLATION_${name.toUpperCase()}`] === '1') active.add(name)
  }
  return active
}

/** Armed with FAULT_<NAME>=1; used to prove that policy errors deny (AC-WP02-07). */
export function throwIfFaultArmed(name: string): void {
  if (process.env[`FAULT_${name.toUpperCase()}`] === '1') {
    throw new Error(`injected fault: ${name}`)
  }
}

/**
 * Test seams: objects a test installs for the duration of a
 * request, such as a scripted Orchestrator. Absent from production images
 * with the rest of this module.
 */
export const testSeams: Record<string, unknown> = {}
