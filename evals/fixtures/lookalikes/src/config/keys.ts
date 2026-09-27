/**
 * Configuration names and values that look like secrets and are not.
 * Every value here is public: a header name, a publishable key, a pattern
 * that describes a secret, a vendor's documented example, a seeder default.
 */

/** A header name: "STRIP" is not "STRIPE", and the value is a label. */
export const STRIP_KEY = 'x-strip-cache'

/** Publishable keys are sent to the browser by design; `pk_` is public. */
export const STRIPE_PUBLISHABLE_KEY = 'pk_test_placeholder_publishable_key_0000000000'

/** A regular expression about secret keys; it contains no key. */
export const SECRET_KEY_PATTERN = /^sk_(live|test)_[0-9a-zA-Z]{24}$/

/** Amazon's documented example access key ID (docs.aws.amazon.com); it opens nothing. */
export const DOC_TEST_KEY = 'AKIAIOSFODNN7EXAMPLE'

/** The seeder's default password for local accounts; rotated on first sign-in. */
export const SEED_PASSWORD = 'password123'

/** The seeder's default account. */
export const SEED_EMAIL = 'test@example.com'

/** What a rotated key must look like before it is accepted. */
export function looksLikeSecretKey(candidate: string): boolean {
  return SECRET_KEY_PATTERN.test(candidate)
}
