/**
 * association-ios-cross-field.spec.ts — Phase 51 regression suite for the iOS fail-open.
 *
 * `AssociationAssociateBuilder.validateNonceCrossField` used to gate on
 * `platformDetails?.type === 'Android'`, so an iOS attestation skipped the cross-field anti-relay
 * check ENTIRELY. It was unreachable only because nothing produced iOS attestations; it would have
 * become live the moment an iOS producer shipped.
 *
 * The Android CONTROL in each pair is the point. Spike 080 found this precisely by observing that
 * the Android case emitted `NONCE_MISMATCH` for a wrong nonce while the identical iOS case emitted
 * nothing — a bug that is invisible unless you compare the two.
 */
import { expect } from 'aegir/chai'
import type { DeviceAttestation, IAssociationEngine } from '@votetorrent/vote-core'
import { AssociationAssociateBuilder } from '../src/association/builders/association-associate-builder.js'
import { recomputeChallengeDigest } from '../src/association/verifiers/digest-binding.js'

const NONCE = 'phase51-challenge-nonce'
const DEVICE_KEY = 'phase51-device-key'
const BOUND = recomputeChallengeDigest(NONCE, DEVICE_KEY)

const engine = {} as unknown as IAssociationEngine
const signature = (() => ({ signature: 's', signerKey: 'k', signerUserId: 'u' })) as never

function iosDetails (overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'iOS',
    secureEnclavePublicKey: DEVICE_KEY,
    appAttestKeyId: 'a2V5',
    assertion: 'YXNzZXJ0',
    assertionCounter: 1,
    popSignature: 'ab'.repeat(64),
    boundDigest: BOUND,
    environment: 'development',
    ...overrides
  }
}

function build (platformDetails: Record<string, unknown>): AssociationAssociateBuilder {
  return new AssociationAssociateBuilder(engine)
    .setRegistrantId('reg-1')
    .setDeviceKey(DEVICE_KEY)
    .setNonce(NONCE)
    .setAttestation({
      publicKey: DEVICE_KEY,
      deviceId: 'device-1',
      attestationTime: Date.now(),
      certificateChain: [],
      platformDetails
    } as unknown as DeviceAttestation)
    .setSignatureOrCallback(signature)
}

const codes = (b: AssociationAssociateBuilder): string[] => b.errors().map(e => e.code)

describe('AssociationAssociateBuilder — iOS cross-field binding (Phase 51 fail-open fix)', () => {
  it('accepts a conformant iOS attestation', () => {
    expect(build(iosDetails()).errors()).to.deep.equal([])
  })

  it('REGRESSION: rejects an iOS attestation whose boundDigest does not answer this challenge', () => {
    // Before the fix this produced ZERO errors — the whole point of the suite.
    expect(codes(build(iosDetails({ boundDigest: 'not-the-right-digest' })))).to.include('NONCE_MISMATCH')
  })

  it('REGRESSION: rejects an iOS attestation bound to a different device key', () => {
    expect(codes(build(iosDetails({ secureEnclavePublicKey: 'a-different-key' })))).to.include('DEVICE_KEY_MISMATCH')
  })

  it('rejects a zero assertion counter at association time', () => {
    expect(codes(build(iosDetails({ assertionCounter: 0 })))).to.include('INVALID')
  })

  it('rejects a non-integer assertion counter', () => {
    expect(codes(build(iosDetails({ assertionCounter: 1.5 })))).to.include('INVALID')
  })

  it('recomputes the digest rather than trusting a self-consistent submission', () => {
    // The attacker supplies a boundDigest that IS a valid digest — just of a different challenge.
    const otherChallenge = recomputeChallengeDigest('some-other-nonce', DEVICE_KEY)
    expect(codes(build(iosDetails({ boundDigest: otherChallenge })))).to.include('NONCE_MISMATCH')
  })

  describe('Android control — behaviour must be unchanged', () => {
    const android = (nonce: string): Record<string, unknown> => ({
      type: 'Android', safetyNetAttestation: 'blob', keystorePublicKey: 'kpk', nonce
    })

    it('accepts a matching Android nonce', () => {
      expect(build(android(NONCE)).errors()).to.deep.equal([])
    })

    it('still rejects a mismatched Android nonce', () => {
      expect(codes(build(android('wrong-nonce')))).to.include('NONCE_MISMATCH')
    })
  })

  it('does not cross-check an unknown platform tag — that is the verifier\'s call', () => {
    // The dispatching verifier fails closed on unknown platforms; the builder has nothing
    // meaningful to compare, and inventing a rule here would diverge from where it is enforced.
    expect(build({ type: 'Windows', whatever: 1 }).errors()).to.deep.equal([])
  })

  it('is inert when the attestation carries no platform details at all', () => {
    expect(build(undefined as unknown as Record<string, unknown>).errors()).to.deep.equal([])
  })
})
