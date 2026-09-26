/**
 * Security event catalogue (SEC-38). Each entry names the only
 * fields an emission may carry: identifiers, codes and counts, never request
 * content. Alert thresholds are recorded here so the catalogue is the single
 * source for both emission tests and alert rules.
 */
export type Severity = 'info' | 'warning' | 'high' | 'critical'

export interface CatalogueEntry {
  severity: Severity
  fields: readonly string[]
  alert: string
}

const define = <T extends Record<string, CatalogueEntry>>(entries: T) => entries

export const SECURITY_EVENT_CATALOGUE = define({
  'auth.sign_in.succeeded': {
    severity: 'info',
    fields: ['issuer', 'sessionId'],
    alert: 'none',
  },
  'auth.sign_in.failed': {
    severity: 'warning',
    fields: ['issuer', 'reason', 'requestId'],
    alert: 'more than 20 per identity provider in 10 minutes',
  },
  'auth.step_up.required': {
    severity: 'info',
    fields: ['action', 'requestId'],
    alert: 'none',
  },
  'auth.step_up.failed': {
    severity: 'warning',
    fields: ['action', 'reason', 'requestId'],
    alert: 'more than 5 per user in 10 minutes',
  },
  'authz.denied': {
    severity: 'warning',
    fields: ['policy', 'resource', 'requestId'],
    alert: 'more than 20 per user in 10 minutes',
  },
  'authz.not_found_burst': {
    severity: 'high',
    fields: ['count', 'windowSeconds', 'requestId'],
    alert: 'any occurrence',
  },
  'policy.enforced': {
    severity: 'high',
    fields: ['rule', 'decision', 'turnId', 'requestId'],
    alert: 'honeytoken rules are P1; others more than 10 per workspace per hour',
  },
  'injection.suspected': {
    severity: 'warning',
    fields: ['workspaceId', 'sub', 'detector'],
    alert:
      'more than 5 per workspace in 10 minutes (a poisoned repository being asked about); emitted by the gateway on an annotated request, which is still forwarded',
  },
  'canary.followed': {
    severity: 'warning',
    fields: ['workspaceId', 'severity'],
    alert:
      'a rate, never a page: alert when the share of sampled turns that follow the planted instruction exceeds twice the live lane fixture baseline over a rolling week (19.4% on 2026-09-18, so 40%). A hit is the gateway stopping the product doing something it should not, which is the system working; what is worth waking for is production diverging from the fixtures every other decision is calibrated against',
  },
  'ingest.injection_rate_changed': {
    severity: 'warning',
    fields: ['repositoryId', 'previousRate', 'rate', 'flagged', 'chunks'],
    alert:
      'any occurrence: the share of chunks carrying instruction-shaped prose rose sharply against the previous commit of the same repository. A level is noise at a 0.153 false-positive rate; a change is not. Reports only — the flag never gates',
  },
  'ingest.rejected': {
    severity: 'warning',
    fields: ['reason', 'repositoryId', 'requestId'],
    alert: 'more than 10 per workspace in 1 hour',
  },
  'repository.deleted': {
    severity: 'info',
    fields: ['repositoryId', 'requestId'],
    alert: 'more than 5 per workspace in 1 hour',
  },
  'workspace.created': {
    severity: 'info',
    fields: ['workspaceId', 'ownerUserId', 'requestId'],
    alert: 'any occurrence outside a deployment window',
  },
  'token.replayed': {
    severity: 'critical',
    fields: ['jti', 'requestId'],
    alert: 'any occurrence',
  },
  'egress.forbidden': {
    severity: 'critical',
    fields: ['service', 'destinationHash'],
    alert: 'any occurrence',
  },
  'cost.reconciliation_drift': {
    severity: 'high',
    fields: ['day', 'route', 'dimension', 'varianceUsd'],
    alert:
      'any occurrence (Integrity class); emitted by services/cost-reconciler, never on a request path',
  },
  'config.changed': {
    severity: 'high',
    fields: ['component', 'configHash', 'previousConfigHash'],
    alert: 'any change outside a deployment',
  },
  'error.unhandled': {
    severity: 'warning',
    fields: ['errorCode', 'errorHash', 'status', 'requestId'],
    alert: 'more than 50 in 5 minutes',
  },
})

export type SecurityEventName = keyof typeof SECURITY_EVENT_CATALOGUE

export type SecurityEventFields<N extends SecurityEventName> = Partial<
  Record<(typeof SECURITY_EVENT_CATALOGUE)[N]['fields'][number], string | number>
>
