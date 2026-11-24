// The officer-side verifier for token attestations (CLI-04) and the composer that puts it beside the
// platform verifiers. It exists ONLY in packages/vote-cli and is never compiled into either app: a
// production Authority has no code path that accepts a token attestation, whatever flags it is given.
// Inside the CLI it is fail-closed too: construction throws unless the officer's posture says
// `--accept-token-attestations` and the party is not the production id.
//
// `verify` checks the marker and the exact shape the producer emits, requires an explicit nonce echo
// (the StubAttestationVerifier delegate lets an ABSENT nonce pass), binds the attested key to the
// challenged device key in canonical form, requires a device id, and then delegates verbatim. It
// never throws; every refusal is a fixed reason string that echoes no value.

import { StubAttestationVerifier, p256KeyToCompressedHex } from '@votetorrent/vote-engine/rn'
import type { AttestationChallenge, AttestationVerification, DeviceAttestation, IAttestationVerifier } from '@votetorrent/vote-core'
import {
  TOKEN_ATTESTATION_MARKER,
  assertTokenAttestationPosture,
  isTokenAttestation,
  tokenAttestationChainEntry,
  type TokenAttestationPosture
} from './marker.js'

const MAX_DEVICE_ID_CHARS = 128

const REASON = Object.freeze({
  noNonce: 'challenge carries no nonce',
  platform: 'not a token attestation (platform)',
  marker: 'not a token attestation (marker)',
  chain: 'token attestation chain malformed',
  nonce: 'attestation nonce does not answer the issued challenge nonce',
  key: 'attestation key does not match the challenged device key',
  deviceId: 'attestation carries no device id',
  rejected: 'token attestation rejected'
})

function reject(reason: string): AttestationVerification {
  return { ok: false, reason }
}

function isSingleEntry(chain: unknown, expected: string): boolean {
  return Array.isArray(chain) && chain.length === 1 && chain[0] === expected
}

export class TokenAttestationVerifier implements IAttestationVerifier {
  private readonly delegate: IAttestationVerifier

  /** Throws `not-enabled`, `party-missing` or `production-party` through assertTokenAttestationPosture. */
  constructor(posture: TokenAttestationPosture) {
    assertTokenAttestationPosture(posture)
    this.delegate = new StubAttestationVerifier()
  }

  async verify(challenge: AttestationChallenge, attestation: DeviceAttestation): Promise<AttestationVerification> {
    try {
      const nonce: unknown = challenge?.nonce
      if (typeof nonce !== 'string' || nonce.length === 0) return reject(REASON.noNonce)
      const details = attestation?.platformDetails
      if (details?.type !== 'Android') return reject(REASON.platform)
      if (details.safetyNetAttestation !== TOKEN_ATTESTATION_MARKER) return reject(REASON.marker)
      if (
        !isSingleEntry(attestation.certificateChain, tokenAttestationChainEntry('fresh')) ||
        !isSingleEntry(details.deviceKeyCertificateChain, tokenAttestationChainEntry('deviceKey'))
      ) {
        return reject(REASON.chain)
      }
      const echoed: unknown = details.nonce
      if (typeof echoed !== 'string' || echoed.length === 0 || echoed !== nonce) return reject(REASON.nonce)
      let attested: string
      let keystore: string
      let challenged: string
      try {
        attested = p256KeyToCompressedHex(attestation.publicKey)
        keystore = p256KeyToCompressedHex(details.keystorePublicKey)
        challenged = p256KeyToCompressedHex(challenge.deviceKey)
      } catch {
        return reject(REASON.key)
      }
      if (attested !== challenged || keystore !== challenged) return reject(REASON.key)
      const deviceId: unknown = attestation.deviceId
      if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > MAX_DEVICE_ID_CHARS) {
        return reject(REASON.deviceId)
      }
      return await this.delegate.verify(challenge, attestation)
    } catch {
      return reject(REASON.rejected)
    }
  }
}

/**
 * Routes on the marker: token-shaped attestations go to the token verifier, everything else to the
 * platform verifier. Each result is returned verbatim and one verifier never sees the other's input.
 */
export class TokenOrPlatformAttestationVerifier implements IAttestationVerifier {
  constructor(
    private readonly tokenVerifier: TokenAttestationVerifier,
    private readonly platformVerifier: IAttestationVerifier
  ) {}

  async verify(challenge: AttestationChallenge, attestation: DeviceAttestation): Promise<AttestationVerification> {
    if (isTokenAttestation(attestation)) return await this.tokenVerifier.verify(challenge, attestation)
    return await this.platformVerifier.verify(challenge, attestation)
  }
}

export interface ComposeOfficerAttestationVerifierOptions extends TokenAttestationPosture {
  readonly platformVerifier: IAttestationVerifier
}

/**
 * The officer's one composition call. Disabled (anything but strictly `true`) returns the platform
 * verifier itself, the production posture, byte-identical. Enabled returns the router over a
 * TokenAttestationVerifier, whose posture throw (`production-party`, `party-missing`) propagates.
 */
export function composeOfficerAttestationVerifier(opts: ComposeOfficerAttestationVerifierOptions): IAttestationVerifier {
  if (opts.acceptTokenAttestations !== true) return opts.platformVerifier
  const tokenVerifier = new TokenAttestationVerifier({ acceptTokenAttestations: opts.acceptTokenAttestations, partyId: opts.partyId })
  return new TokenOrPlatformAttestationVerifier(tokenVerifier, opts.platformVerifier)
}
