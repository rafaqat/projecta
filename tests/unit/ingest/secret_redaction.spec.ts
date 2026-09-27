import { test } from '@japa/runner'
import { redactSecrets } from '#app/ingest/secret_redaction'

/**
 * The broadened rules (v3): higher-confidence secret classes the earlier set missed. Citations are
 * hydrated from the redacted blob and bypass the gateway, so ingest redaction is the SOLE protection
 * for secrets shown in a citation snippet — a missed class would sit in plaintext with no backstop.
 * Each secret-shaped value is assembled from parts so the committed test does not trip gitleaks, and
 * the negatives guard against over-redaction (a false positive silently loses real code from an index).
 */
const KEY = Buffer.from('0'.repeat(64), 'hex')

const REDACTS: Array<[string, string]> = [
  ['url_credentials (user:pass)', 'DATABASE_URL=postgres://admin:' + 'S3cr3t' + '@db/prod'],
  ['url_credentials (password-only)', 'redis://:' + 'p4ss' + '@cache:6379'],
  ['aws_secret_access_key', 'aws_secret_access_key = "' + 'w'.repeat(40) + '"'],
  ['google_api_key', 'const k = "' + 'AIza' + 'x'.repeat(35) + '"'],
  ['stripe_key', 'STRIPE=' + 'sk_' + 'live_' + 'y'.repeat(24)],
  ['npm_token', 'token ' + 'npm_' + 'z'.repeat(36)],
  ['slack_webhook', 'https://hooks.slack.com/services/' + 'T00/B00/abcd1234'],
]

const CLEAN: Array<[string, string]> = [
  ['a plain url', 'see https://github.com/foo/bar for docs'],
  ['an ssh remote', 'git clone git@github.com:foo/bar.git'],
  ['a url with a port, no credentials', 'connect to https://example.com:8080/api'],
  ['a 40-char string not near an aws key name', 'const note = "' + 'w'.repeat(40) + '"'],
]

test.group('ingest/secret_redaction · broadened rules (v3)', () => {
  for (const [name, input] of REDACTS)
    test(`redacts ${name}`, ({ assert }) => {
      const result = redactSecrets(input, KEY)
      assert.isAtLeast(result.findings.length, 1, `${name} must be redacted`)
      assert.include(result.content, '<<REDACTED:', 'a typed placeholder replaces the secret')
    }).tags(['ingest', 'redaction', 'security'])

  for (const [name, input] of CLEAN)
    test(`does not redact ${name}`, ({ assert }) => {
      const result = redactSecrets(input, KEY)
      assert.lengthOf(result.findings, 0, `${name} must stay clean (no over-redaction)`)
      assert.equal(result.content, input)
    }).tags(['ingest', 'redaction', 'security'])
})
