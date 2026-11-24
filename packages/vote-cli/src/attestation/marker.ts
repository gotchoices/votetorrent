// The token-attestation marker and the officer posture rule (CLI-04). A CLI voter has no hardware
// keystore, so its association answer carries this marker (the fragments `vt-cli-token-` and
// `attestation-v1`, joined) where a device would carry a Play Integrity statement, and the officer
// accepts it ONLY when explicitly told to and never on the production party. The marker is distinct
// from the dev stub's placeholders and from the lean rig's host-voter marker, so no production or dev
// verifier ever reads it as anything but foreign.
//
// Everything here lives only in packages/vote-cli and is imported by neither app nor by workflows:
// a release bundle cannot accept a token attestation because it does not contain the code to.

/** The one whole occurrence of the marker in this package. Elsewhere, reference this constant. */
export const TOKEN_ATTESTATION_MARKER = 'vt-cli-token-attestation-v1'

/** Chain-entry suffixes (the host-voter rule): the nonce-bound throwaway chain and the voting-key chain. */
export const TOKEN_ATTESTATION_CHAIN_SUFFIX = Object.freeze({ fresh: ':throwaway', deviceKey: ':voting-key' })

export type TokenAttestationChainKind = keyof typeof TOKEN_ATTESTATION_CHAIN_SUFFIX

/** Standard base64 of the utf8 of the marker plus the suffix, the host-voter `b64` rule. */
export function tokenAttestationChainEntry(kind: TokenAttestationChainKind): string {
  return Buffer.from(`${TOKEN_ATTESTATION_MARKER}${TOKEN_ATTESTATION_CHAIN_SUFFIX[kind]}`, 'utf8').toString('base64')
}

/** The production party id, as a comparand only. The apps keep their own PARTY_ID; nothing here imports an app. */
export const PRODUCTION_PARTY_ID = 'votetorrent'

export type TokenAttestationErrorCode =
  | 'not-enabled'
  | 'production-party'
  | 'party-missing'
  | 'DEVICE_KEY_ABSENT'
  | 'DEVICE_KEY_INVALIDATED'
  | 'device-key-mismatch'
  | 'invalid-challenge'
  | 'invalid-device-id'

export class TokenAttestationError extends Error {
  readonly code: TokenAttestationErrorCode

  constructor(code: TokenAttestationErrorCode) {
    super(`token attestation refused (${code})`)
    this.name = 'TokenAttestationError'
    this.code = code
  }
}

export interface TokenAttestationPosture {
  /** Strictly `true` enables; anything else (including a truthy string) is refused. */
  readonly acceptTokenAttestations: boolean
  /** The officer's `--party`; refused when it is the production id, trimmed and case-folded. */
  readonly partyId: string
}

/**
 * The officer's posture check, run at flag parse before any node boots: throws `not-enabled` unless
 * `acceptTokenAttestations === true`, `party-missing` unless `partyId` is a non-empty string, and
 * `production-party` when the party is the production id.
 */
export function assertTokenAttestationPosture(posture: TokenAttestationPosture): void {
  if (posture.acceptTokenAttestations !== true) throw new TokenAttestationError('not-enabled')
  const partyId: unknown = posture.partyId
  if (typeof partyId !== 'string' || partyId.length === 0) throw new TokenAttestationError('party-missing')
  if (partyId.trim().toLowerCase() === PRODUCTION_PARTY_ID) throw new TokenAttestationError('production-party')
}

/**
 * A routing discriminant only, not verification: true iff the attestation is Android-typed and its
 * `safetyNetAttestation` is the marker. Never throws.
 */
export function isTokenAttestation(att: unknown): boolean {
  try {
    const details = (att as { platformDetails?: { type?: unknown, safetyNetAttestation?: unknown } } | null | undefined)?.platformDetails
    return details?.type === 'Android' && details.safetyNetAttestation === TOKEN_ATTESTATION_MARKER
  } catch {
    return false
  }
}
