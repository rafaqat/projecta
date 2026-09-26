import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'

/**
 * Ed25519 batch signing for the audit chain. The writer's key
 * comes from AUDIT_SIGNING_SEED (32 bytes hex; Key Vault on Azure); the
 * verifier needs only the public key. Pure node:crypto so the service and
 * the app share it.
 */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export function signingKeyFromSeed(hexSeed: string): KeyObject {
  const seed = Buffer.from(hexSeed, 'hex')
  if (seed.length !== 32) throw new Error('AUDIT_SIGNING_SEED must be 32 bytes of hex')
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  })
}

export function publicKeyOf(key: KeyObject): KeyObject {
  return createPublicKey(key)
}

export function keyId(publicKey: KeyObject): string {
  return (publicKey.export({ format: 'jwk' }) as { x: string }).x.slice(0, 16)
}

export function signDigest(key: KeyObject, digest: Buffer): string {
  return sign(null, digest, key).toString('base64url')
}

export function verifyDigest(publicKey: KeyObject, digest: Buffer, signature: string): boolean {
  try {
    return verify(null, digest, publicKey, Buffer.from(signature, 'base64url'))
  } catch {
    return false
  }
}
