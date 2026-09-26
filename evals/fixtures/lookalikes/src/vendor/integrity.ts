/**
 * High-entropy strings that are not secrets: a lockfile integrity hash, a
 * commit SHA, a content hash, a data URI and a public signing key.
 */

/** The integrity field of a lockfile entry: a hash of public bytes. */
export const LOCKFILE_INTEGRITY =
  'sha512-8xOcRHvCjnocdS5cpwXQXVzmmh5e5+saE2QGoeQmbKmRS6J3VQppPOIt0MnmE+4xlZoumy0GPG0D0MVIQbNA1A=='

/** The commit this build was made from. */
export const COMMIT_SHA = '3f786850e387550fdab836ed7e6dc881de23001b'

/** The content hash of the generated bundle. */
export const CONTENT_HASH = 'd41d8cd98f00b204e9800998ecf8427e'

/** A one-pixel transparent GIF, inlined so no request is made for it. */
export const TRANSPARENT_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

/** The public half of the release signing key; verification only. */
export const SIGNING_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE4l7A3Q2bH0vG5a8Y2t9iV0nXo6gJ
6fQxq2s8pH1JZ3n0dQfV3kY2xN8mQ1b7tW5lC0Z9pR4uS6vT2yK8cJ1mFQ==
-----END PUBLIC KEY-----`

export function isPinnedCommit(sha: string): boolean {
  return sha === COMMIT_SHA
}
