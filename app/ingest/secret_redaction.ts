import { createHmac } from 'node:crypto'
import RE2 from 're2'

/**
 * Secret redaction at ingest (SEC-19). Rules run under RE2 so
 * scanning is linear in the input regardless of content. A match is
 * replaced with a typed placeholder and recorded as a keyed fingerprint
 *; the plaintext never reaches storage, embedding or a model.
 */
export interface SecretRule {
  id: string
  pattern: RE2
}

/** Bumped with any rule change: it keys the derivation cache and joins configHash (BL-01). */
export const REDACTOR_VERSION = 'rules-v2'

/**
 * Values vendors publish as examples in their documentation (WP-19, BL-01).
 * They are key-shaped and open nothing; redacting them mutates ordinary
 * source and shows a redaction badge on documentation. Reviewed, named,
 * and never a real credential.
 */
export const DOCUMENTED_EXAMPLES = new Set([
  'AKIAIOSFODNN7EXAMPLE', // AWS documentation example access key ID
  'AKIAI44QH8DHBEXAMPLE', // AWS documentation example access key ID
])

export const SECRET_RULES: SecretRule[] = [
  {
    id: 'aws_access_key',
    pattern: new RE2('\\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\\b', 'g'),
  },
  { id: 'github_token', pattern: new RE2('\\bgh[pousr]_[A-Za-z0-9]{36,255}\\b', 'g') },
  {
    id: 'github_fine_grained_token',
    pattern: new RE2('\\bgithub_pat_[A-Za-z0-9_]{22,255}\\b', 'g'),
  },
  { id: 'anthropic_api_key', pattern: new RE2('\\bsk-ant-[A-Za-z0-9_-]{20,}\\b', 'g') },
  { id: 'slack_token', pattern: new RE2('\\bxox[abpr]-[A-Za-z0-9-]{10,}\\b', 'g') },
  { id: 'azure_storage_key', pattern: new RE2('AccountKey=[A-Za-z0-9+/]{86}==', 'g') },
  {
    id: 'private_key',
    pattern: new RE2(
      '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----',
      'g'
    ),
  },
]

export interface RedactionFinding {
  rule: string
  fingerprint: string
  line: number
}

export interface RedactionResult {
  content: string
  findings: RedactionFinding[]
}

export function fingerprint(secret: string, workspaceKey: Buffer): string {
  return createHmac('sha256', workspaceKey).update(secret).digest('hex')
}

export function redactSecrets(source: string, workspaceKey: Buffer): RedactionResult {
  const findings: RedactionFinding[] = []
  let content = source
  for (const rule of SECRET_RULES) {
    content = content.replace(rule.pattern, (match: string, offset: number) => {
      if (DOCUMENTED_EXAMPLES.has(match)) return match
      const print = fingerprint(match, workspaceKey)
      const line = content.slice(0, offset).split('\n').length
      findings.push({ rule: rule.id, fingerprint: print, line })
      return `<<REDACTED:${rule.id}:${print.slice(0, 8)}>>`
    })
  }
  return { content, findings }
}
