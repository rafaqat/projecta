/*
 * Bouncer policy registry. Hand-written in place of the adonis-generated
 * `#generated/policies` so the map is a committed source file, not a build
 * artefact (the telemetry/codegen slice can restore generation later).
 */
export const policies = {
  RepositoryPolicy: () => import('#policies/repository_policy'),
  WorkspacePolicy: () => import('#policies/workspace_policy'),
}
