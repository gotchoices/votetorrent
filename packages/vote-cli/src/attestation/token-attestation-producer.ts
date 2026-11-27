// The CLI voter's VoteSigningProducer over a token-gated software P-256 K_vote (CLI-04). The key
// lives in the vote-cli file vault under the approval token; `produce` answers a challenge with the
// host-voter Android shape (nonce echoed, token-attestation marker in place of a platform statement)
// after proving the token and the key, and `signDeviceKeyDigest` signs under the Android rule the
// schema's SignatureValidP256 verifies.
//
// provisionDeviceKey is LOAD-OR-CREATE, unlike Android's rotate-per-call: the ceremony already reads
// the key through getCurrentDeviceKey, a refused token must never cost the voter its voting key, and
// a caller that wants a fresh key calls deleteTokenSigningKey first. Only a half-present orphan (one
// alias of the pair) is cleared before minting.
//
// Nothing here logs; the deviceId is a secret-class value and never enters a message.

import { p256KeyToCompressedHex } from '@votetorrent/vote-engine/rn'
import type { AndroidAttestationDetails, AttestationChallenge, DeviceAttestation, Signature } from '@votetorrent/vote-core'
import type { SignDeviceKeyDigestOptions, VoteSigningProducer } from '@votetorrent/workflows/platform'
import type { ApprovalContext } from '../approval/token.js'
import {
  assertTokenSigningKeyHeld,
  createTokenSigner,
  deleteTokenSigningKey,
  provisionTokenSigningKey,
  readTokenSigningPublicKey,
  tokenSigningPublicKeyAlias,
  type ApprovalScopedVault
} from '../approval/signer.js'
import { TOKEN_ATTESTATION_MARKER, TokenAttestationError, tokenAttestationChainEntry } from './marker.js'

const MAX_DEVICE_ID_CHARS = 128
const CURVE = 'p256'

export interface CreateTokenAttestationProducerOptions {
  readonly vault: ApprovalScopedVault
  readonly token: ApprovalContext
  /** The private K_vote alias; the public half sits under `${alias}.pub`. */
  readonly alias: string
  /** The voter's device id, registered as a secret by the caller; never logged here. */
  readonly deviceId: string
  /** Clock for `attestationTime`; defaults to Date.now. */
  readonly now?: () => number
}

function abortError(): Error {
  return Object.assign(new Error('signDeviceKeyDigest: abandoned before the sign'), { name: 'AbortError', code: 'ABORTED' })
}

export function createTokenAttestationProducer(opts: CreateTokenAttestationProducerOptions): VoteSigningProducer {
  const pubAlias = tokenSigningPublicKeyAlias(opts.alias)
  const { vault, token, alias, deviceId } = opts
  if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > MAX_DEVICE_ID_CHARS) {
    throw new TokenAttestationError('invalid-device-id')
  }
  const now = opts.now ?? Date.now

  async function getCurrentDeviceKey(): Promise<{ publicKey: string }> {
    const publicKey = await readTokenSigningPublicKey({ vault, alias })
    if (publicKey === null) throw new TokenAttestationError('DEVICE_KEY_ABSENT')
    if (!(await vault.hasSecret(alias))) throw new TokenAttestationError('DEVICE_KEY_INVALIDATED')
    return { publicKey }
  }

  async function provisionDeviceKey(): Promise<{ publicKey: string }> {
    const hasPrivate = await vault.hasSecret(alias)
    const hasPublic = await vault.hasSecret(pubAlias)
    if (hasPrivate && hasPublic) {
      const publicKey = await readTokenSigningPublicKey({ vault, alias })
      if (publicKey !== null) return { publicKey }
    } else if (hasPrivate || hasPublic) {
      await deleteTokenSigningKey({ vault, alias })
    }
    return provisionTokenSigningKey({ vault, token, curve: CURVE, alias })
  }

  async function produce(challenge: AttestationChallenge): Promise<DeviceAttestation> {
    const c = challenge as Partial<AttestationChallenge> | null | undefined
    if (
      c === null ||
      typeof c !== 'object' ||
      typeof c.nonce !== 'string' ||
      c.nonce.length === 0 ||
      typeof c.deviceKey !== 'string' ||
      typeof c.registrantId !== 'string'
    ) {
      throw new TokenAttestationError('invalid-challenge')
    }
    const { publicKey: current } = await getCurrentDeviceKey()
    let canonical: string
    try {
      canonical = p256KeyToCompressedHex(c.deviceKey)
    } catch {
      throw new TokenAttestationError('device-key-mismatch')
    }
    if (canonical !== current) throw new TokenAttestationError('device-key-mismatch')
    await assertTokenSigningKeyHeld({ vault, token, curve: CURVE, alias, signerKey: current })
    const platformDetails: AndroidAttestationDetails = {
      type: 'Android',
      safetyNetAttestation: TOKEN_ATTESTATION_MARKER,
      keystorePublicKey: c.deviceKey,
      nonce: c.nonce,
      deviceKeyCertificateChain: [tokenAttestationChainEntry('deviceKey')]
    }
    return {
      publicKey: c.deviceKey,
      deviceId,
      attestationTime: now(),
      certificateChain: [tokenAttestationChainEntry('fresh')],
      platformDetails
    }
  }

  async function signDeviceKeyDigest(digest: Uint8Array, options?: SignDeviceKeyDigestOptions): Promise<Signature> {
    if (options?.signal?.aborted) throw abortError()
    const { publicKey: current } = await getCurrentDeviceKey()
    return createTokenSigner({ vault, token, curve: CURVE, alias, signerUserId: '', signerKey: current })(digest)
  }

  return { provisionDeviceKey, getCurrentDeviceKey, produce, signDeviceKeyDigest }
}
