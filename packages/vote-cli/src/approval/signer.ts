// The token-gated software signer (CLI-04). Possession of the approval token stands in for user
// presence on Node: every signature unwraps the private key through `vault.withApproval(token)`,
// signs, and zero-fills the key. Nothing is cached across calls, so a missing or wrong token on any
// call refuses that call with no signature. secp256k1 serves officers and voter identity keys; P-256
// serves K_vote under the Android `SHA256withECDSA` rule (one hash over the digest, low-S, compact),
// which is the rule the schema's SQL `SignatureValidP256` verifies. The iOS Secure Enclave rule (the
// input IS the final hash) is never used here: the token attestation is Android-shaped.
//
// Error messages are a fixed shape, `token signer refused (<code>, <operation>)`, and never carry an
// alias, bytes, hex, a digest or a token. The vault error that caused a refusal travels in `cause`.

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { p256 } from '@noble/curves/nist.js'
import { bytesToHex } from '@noble/curves/utils.js'
import { assertKeyVaultAlias } from '@votetorrent/vote-engine/rn'
import type { IKeyVault, KeyVaultPolicy } from '@votetorrent/vote-engine/rn'
import type { SignCallback, Signature } from '@votetorrent/workflows/platform'
import type { ApprovalContext } from './token.js'

export type TokenSignerCurve = 'secp256k1' | 'p256'

/** The private half: sealed under the approval token, so every unwrap needs the token present. */
export const TOKEN_SIGNING_KEY_POLICY: KeyVaultPolicy = Object.freeze({ requireUserAuth: true })
/** The public half: an at-rest record readable with no token and no prompt. */
export const TOKEN_SIGNING_PUBLIC_KEY_POLICY: KeyVaultPolicy = Object.freeze({ requireUserAuth: false })

/**
 * The vault the signer needs: the engine IKeyVault plus the prompt counter and a per-call approval
 * view. The vote-cli FileKeyVault satisfies it structurally.
 */
export interface ApprovalScopedVault extends IKeyVault {
  // The four IKeyVault members restated, so the contract reads whole here and survives a type-only
  // resolution of the engine entry.
  putSecret: (alias: string, secret: Uint8Array, policy: KeyVaultPolicy) => Promise<void>
  getSecret: (alias: string) => Promise<Uint8Array | null>
  hasSecret: (alias: string) => Promise<boolean>
  deleteSecret: (alias: string) => Promise<boolean>
  readonly authPromptCount: number
  withApproval(approval: ApprovalContext): IKeyVault & { readonly authPromptCount: number }
}

export type TokenSignerErrorCode =
  | 'token-refused'
  | 'key-absent'
  | 'key-policy'
  | 'key-invalid'
  | 'key-mismatch'
  | 'key-exists'
  | 'key-unavailable'
  | 'invalid-alias'
  | 'invalid-digest'
  | 'invalid-curve'
  | 'invalid-signer'

export type TokenSignerOperation = 'sign' | 'provision' | 'read' | 'hold'

export class TokenSignerError extends Error {
  readonly code: TokenSignerErrorCode
  readonly operation: TokenSignerOperation

  constructor(code: TokenSignerErrorCode, operation: TokenSignerOperation, cause?: unknown) {
    super(`token signer refused (${code}, ${operation})`, cause === undefined ? undefined : { cause })
    this.name = 'TokenSignerError'
    this.code = code
    this.operation = operation
  }
}

/** The derived public alias adds 4 characters, so the private alias may use at most 124 of the 128. */
const MAX_PRIVATE_ALIAS_CHARS = 124
const PUBLIC_ALIAS_SUFFIX = '.pub'
const COMPRESSED_KEY_RE = /^(02|03)[0-9a-f]{64}$/
const PRIVATE_KEY_BYTES = 32

type Curve = typeof secp256k1 | typeof p256

function curveOf(curve: TokenSignerCurve, op: TokenSignerOperation): Curve {
  if (curve === 'secp256k1') return secp256k1
  if (curve === 'p256') return p256
  throw new TokenSignerError('invalid-curve', op)
}

function validateAlias(alias: string, op: TokenSignerOperation): void {
  try {
    assertKeyVaultAlias(alias)
  } catch (e) {
    throw new TokenSignerError('invalid-alias', op, e)
  }
  if (alias.length > MAX_PRIVATE_ALIAS_CHARS) throw new TokenSignerError('invalid-alias', op)
}

/** `${alias}.pub`; throws `invalid-alias` when the private alias is malformed or longer than 124 characters. */
export function tokenSigningPublicKeyAlias(alias: string): string {
  validateAlias(alias, 'read')
  return `${alias}${PUBLIC_ALIAS_SUFFIX}`
}

function vaultErrorCode(e: unknown): string | undefined {
  const err = e as { name?: unknown, code?: unknown } | undefined
  return err?.name === 'KeyVaultError' && typeof err.code === 'string' ? err.code : undefined
}

function mapUnwrapError(e: unknown, op: TokenSignerOperation): TokenSignerError {
  const code = vaultErrorCode(e)
  if (code === 'auth-denied') return new TokenSignerError('token-refused', op, e)
  return new TokenSignerError('key-unavailable', op, e)
}

export interface ProvisionTokenSigningKeyOptions {
  readonly vault: ApprovalScopedVault
  readonly token: ApprovalContext
  readonly curve: TokenSignerCurve
  readonly alias: string
}

/**
 * Mints a key pair, seals the private half under the token (`TOKEN_SIGNING_KEY_POLICY`) and stores
 * the compressed public hex at rest under `${alias}.pub`. Resolves the 66-char compressed public key.
 * An alias that already holds either half rejects `key-exists` before any token read.
 */
export async function provisionTokenSigningKey(opts: ProvisionTokenSigningKeyOptions): Promise<{ publicKey: string }> {
  const op: TokenSignerOperation = 'provision'
  const impl = curveOf(opts.curve, op)
  validateAlias(opts.alias, op)
  const { vault, alias, token } = opts
  const pubAlias = `${alias}${PUBLIC_ALIAS_SUFFIX}`
  if ((await vault.hasSecret(alias)) || (await vault.hasSecret(pubAlias))) {
    throw new TokenSignerError('key-exists', op)
  }
  const priv = impl.utils.randomSecretKey()
  try {
    const publicKey = bytesToHex(impl.getPublicKey(priv, true))
    try {
      await vault.withApproval(token).putSecret(alias, priv, TOKEN_SIGNING_KEY_POLICY)
    } catch (e) {
      const code = vaultErrorCode(e)
      if (code === 'auth-denied') throw new TokenSignerError('token-refused', op, e)
      if (code === 'alias-exists') throw new TokenSignerError('key-exists', op, e)
      throw new TokenSignerError('key-unavailable', op, e)
    }
    try {
      await vault.putSecret(pubAlias, Buffer.from(publicKey, 'utf8'), TOKEN_SIGNING_PUBLIC_KEY_POLICY)
    } catch (e) {
      try {
        await vault.deleteSecret(alias)
      } catch {
        // the private half could not be rolled back; the error below still names the public put
      }
      const code = vaultErrorCode(e)
      if (code === 'alias-exists') throw new TokenSignerError('key-exists', op, e)
      throw new TokenSignerError('key-unavailable', op, e)
    }
    return { publicKey }
  } finally {
    priv.fill(0)
  }
}

export interface TokenSigningKeyRef {
  readonly vault: ApprovalScopedVault
  readonly alias: string
}

/**
 * The stored public half, or null when absent. An at-rest read: no token and no prompt. A record that
 * does not decode to compressed hex rejects `key-invalid`.
 */
export async function readTokenSigningPublicKey(ref: TokenSigningKeyRef): Promise<string | null> {
  const op: TokenSignerOperation = 'read'
  const pubAlias = tokenSigningPublicKeyAlias(ref.alias)
  let raw: Uint8Array | null
  try {
    raw = await ref.vault.getSecret(pubAlias)
  } catch (e) {
    throw mapUnwrapError(e, op)
  }
  if (raw === null) return null
  try {
    const text = Buffer.from(raw).toString('utf8')
    if (!COMPRESSED_KEY_RE.test(text)) throw new TokenSignerError('key-invalid', op)
    return text
  } finally {
    raw.fill(0)
  }
}

/** Deletes both halves with no token. True when either existed. */
export async function deleteTokenSigningKey(ref: TokenSigningKeyRef): Promise<boolean> {
  const pubAlias = tokenSigningPublicKeyAlias(ref.alias)
  const hadPrivate = await ref.vault.deleteSecret(ref.alias)
  const hadPublic = await ref.vault.deleteSecret(pubAlias)
  return hadPrivate || hadPublic
}

interface UnwrapOptions {
  readonly vault: ApprovalScopedVault
  readonly token: ApprovalContext
  readonly curve: Curve
  readonly alias: string
  readonly signerKey: string | undefined
}

/**
 * The one unwrap path. Resolves the expected public key, unwraps the private key through the token
 * view once, requires the read to have been token-gated, checks the key, runs `use`, and zero-fills
 * the key in a finally on success and on every refusal after the unwrap.
 */
async function withUnwrappedKey<T>(
  op: TokenSignerOperation,
  opts: UnwrapOptions,
  use: (priv: Uint8Array, expected: string) => T
): Promise<T> {
  const { vault, token, alias } = opts
  const expected = opts.signerKey ?? (await readTokenSigningPublicKey({ vault, alias }))
  if (expected === null) throw new TokenSignerError('key-absent', op)
  const view = vault.withApproval(token)
  const before = view.authPromptCount
  let priv: Uint8Array | null
  try {
    priv = await view.getSecret(alias)
  } catch (e) {
    throw mapUnwrapError(e, op)
  }
  if (priv === null) throw new TokenSignerError('key-absent', op)
  try {
    // The counter moved only if the stored record required the token; otherwise the token proved
    // nothing and the record is mis-provisioned. Concurrent verbs can only raise the counter.
    if (view.authPromptCount === before) throw new TokenSignerError('key-policy', op)
    if (priv.length !== PRIVATE_KEY_BYTES) throw new TokenSignerError('key-invalid', op)
    let derived: string
    try {
      derived = bytesToHex(opts.curve.getPublicKey(priv, true))
    } catch (e) {
      throw new TokenSignerError('key-invalid', op, e)
    }
    if (derived !== expected) throw new TokenSignerError('key-mismatch', op)
    return use(priv, expected)
  } finally {
    priv.fill(0)
  }
}

export interface AssertTokenSigningKeyHeldOptions {
  readonly vault: ApprovalScopedVault
  readonly token: ApprovalContext
  readonly curve: TokenSignerCurve
  readonly alias: string
  readonly signerKey: string
}

/** Proves the token and the key (one unwrap, then zero-fill) without signing anything. */
export async function assertTokenSigningKeyHeld(opts: AssertTokenSigningKeyHeldOptions): Promise<void> {
  const op: TokenSignerOperation = 'hold'
  const curve = curveOf(opts.curve, op)
  validateAlias(opts.alias, op)
  if (typeof opts.signerKey !== 'string' || !COMPRESSED_KEY_RE.test(opts.signerKey)) {
    throw new TokenSignerError('invalid-signer', op)
  }
  await withUnwrappedKey(op, { vault: opts.vault, token: opts.token, curve, alias: opts.alias, signerKey: opts.signerKey }, () => undefined)
}

export interface CreateTokenSignerOptions {
  readonly vault: ApprovalScopedVault
  readonly token: ApprovalContext
  readonly curve: TokenSignerCurve
  readonly alias: string
  /** Echoed into every Signature; may be empty for voter device keys. */
  readonly signerUserId: string
  /** The expected compressed public key; when absent, the stored `${alias}.pub` record is read per call. */
  readonly signerKey?: string
}

function signWith(curve: TokenSignerCurve, impl: Curve, digest: Uint8Array, priv: Uint8Array): Uint8Array {
  if (curve === 'p256') {
    // The Android SHA256withECDSA rule: hash the digest once, low-S, compact. SQL SignatureValidP256 verifies this.
    return impl.sign(digest, priv, { lowS: true, prehash: true })
  }
  // The createKeyholderSigner call: noble v2 defaults are prehash true, lowS true, compact.
  return impl.sign(digest, priv)
}

/**
 * Returns the engines' SignCallback. Construction validates the curve, alias, signerUserId and
 * signerKey synchronously; each call validates the digest before any token or vault read, unwraps
 * the key through the token view once, signs, and zero-fills the key.
 */
export function createTokenSigner(opts: CreateTokenSignerOptions): SignCallback {
  const op: TokenSignerOperation = 'sign'
  const impl = curveOf(opts.curve, op)
  validateAlias(opts.alias, op)
  if (typeof opts.signerUserId !== 'string') throw new TokenSignerError('invalid-signer', op)
  if (opts.signerKey !== undefined && (typeof opts.signerKey !== 'string' || !COMPRESSED_KEY_RE.test(opts.signerKey))) {
    throw new TokenSignerError('invalid-signer', op)
  }
  const { vault, token, curve, alias, signerUserId, signerKey } = opts
  return async (digest: Uint8Array): Promise<Signature> => {
    if (!(digest instanceof Uint8Array) || digest.length < 1) throw new TokenSignerError('invalid-digest', op)
    return withUnwrappedKey(op, { vault, token, curve: impl, alias, signerKey }, (priv, expected) => ({
      signature: bytesToHex(signWith(curve, impl, digest, priv)),
      signerKey: expected,
      signerUserId
    }))
  }
}
