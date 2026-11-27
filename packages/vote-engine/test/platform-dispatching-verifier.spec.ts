/**
 * platform-dispatching-verifier.spec.ts — Phase 51. Ports spike 082's 8/8 coverage of
 * `PlatformDispatchingAttestationVerifier` into the shipped suite (it had zero references from any
 * test file before this).
 *
 * The four assertions below map 1:1 onto the four design rules in the file's header comment. Each
 * uses a hand-rolled fake `IAttestationVerifier` whose result the test controls — the point of the
 * fake is that a dispatcher which re-wrapped, swallowed, or leaked a result would be caught by
 * identity/reference checks the fake makes possible, not just an `ok` boolean.
 */
import 'reflect-metadata'
import { expect } from 'aegir/chai'
import type { AttestationChallenge, AttestationVerification, DeviceAttestation, IAttestationVerifier } from '@votetorrent/vote-core'
import { PlatformDispatchingAttestationVerifier } from '../src/association/platform-dispatching-verifier.js'

const CHALLENGE = {
  nonce: 'n',
  authorityId: 'auth-1',
  registrantId: 'reg-1',
  deviceKey: 'device-key-1'
} as unknown as AttestationChallenge

function androidAttestation (): DeviceAttestation {
  return {
    publicKey: 'device-key-1',
    deviceId: 'android-device',
    attestationTime: Date.now(),
    certificateChain: [],
    platformDetails: { type: 'Android', safetyNetAttestation: 'sni', keystorePublicKey: 'k', nonce: 'n' }
  } as unknown as DeviceAttestation
}

function iosAttestation (): DeviceAttestation {
  return {
    publicKey: 'device-key-1',
    deviceId: 'ios-device',
    attestationTime: Date.now(),
    certificateChain: [],
    platformDetails: {
      type: 'iOS',
      secureEnclavePublicKey: 'device-key-1',
      appAttestKeyId: 'kid',
      assertion: 'a',
      assertionCounter: 1,
      popSignature: 'ab'.repeat(64),
      boundDigest: 'd',
      environment: 'development'
    }
  } as unknown as DeviceAttestation
}

/**
 * A fake `IAttestationVerifier` that records every call it receives and returns a fixed, caller-
 * supplied result — so a test can assert BOTH "was I called with the right attestation" (rule 2) and
 * "did the dispatcher hand my exact result back unmodified" (rule 3), by reference identity.
 */
class RecordingVerifier implements IAttestationVerifier {
  public calls: Array<{ challenge: AttestationChallenge, attestation: DeviceAttestation }> = []
  constructor (private readonly result: AttestationVerification) {}

  async verify (challenge: AttestationChallenge, attestation: DeviceAttestation): Promise<AttestationVerification> {
    this.calls.push({ challenge, attestation })
    return this.result
  }
}

describe('PlatformDispatchingAttestationVerifier', () => {
  // ---- Rule 1: fail closed on the default branch ----
  describe('rule 1 — fail closed on an unrecognised or absent platform', () => {
    it('rejects an attestation with NO platformDetails at all, rather than passing it through', async () => {
      const android = new RecordingVerifier({ ok: true })
      const ios = new RecordingVerifier({ ok: true })
      const dispatcher = new PlatformDispatchingAttestationVerifier(android, ios)

      const bare = { publicKey: 'k', deviceId: 'd', attestationTime: 0, certificateChain: [] } as unknown as DeviceAttestation
      const r = await dispatcher.verify(CHALLENGE, bare)

      expect(r.ok).to.equal(false)
      expect(r.reason).to.match(/no platform details/)
      // A fail-open bug would route the absent-platform case to some verifier; assert neither ran.
      expect(android.calls).to.have.length(0)
      expect(ios.calls).to.have.length(0)
    })

    it('rejects a bogus/unknown platform tag, rather than treating it as newly-allowed', async () => {
      const android = new RecordingVerifier({ ok: true })
      const ios = new RecordingVerifier({ ok: true })
      const dispatcher = new PlatformDispatchingAttestationVerifier(android, ios)

      const alien = {
        publicKey: 'k', deviceId: 'd', attestationTime: 0, certificateChain: [],
        platformDetails: { type: 'Windows' }
      } as unknown as DeviceAttestation
      const r = await dispatcher.verify(CHALLENGE, alien)

      expect(r.ok).to.equal(false)
      expect(r.reason).to.match(/unsupported attestation platform: Windows/)
      expect(android.calls).to.have.length(0)
      expect(ios.calls).to.have.length(0)
    })
  })

  // ---- Rule 2: routing happens once, never cross-platform ----
  describe("rule 2 — never lets one platform's verifier see another platform's attestation", () => {
    it('routes an Android attestation to the Android verifier only, never the iOS one', async () => {
      const android = new RecordingVerifier({ ok: true })
      const ios = new RecordingVerifier({ ok: true })
      const dispatcher = new PlatformDispatchingAttestationVerifier(android, ios)

      const attestation = androidAttestation()
      await dispatcher.verify(CHALLENGE, attestation)

      expect(android.calls).to.have.length(1)
      expect(android.calls[0].attestation).to.equal(attestation)
      expect(ios.calls).to.have.length(0)
    })

    it('routes an iOS attestation to the iOS verifier only, never the Android one', async () => {
      const android = new RecordingVerifier({ ok: true })
      const ios = new RecordingVerifier({ ok: true })
      const dispatcher = new PlatformDispatchingAttestationVerifier(android, ios)

      const attestation = iosAttestation()
      await dispatcher.verify(CHALLENGE, attestation)

      expect(ios.calls).to.have.length(1)
      expect(ios.calls[0].attestation).to.equal(attestation)
      expect(android.calls).to.have.length(0)
    })
  })

  // ---- Rule 3: delegation is verbatim, both on pass and on fail ----
  describe('rule 3 — Android delegation is verbatim (no re-wrapping, no reason rewriting)', () => {
    it('returns the Android verifier\'s ok:true result completely unmodified', async () => {
      // A distinguishable object identity, not just a shape-alike literal: a dispatcher that
      // rebuilt `{ ok: true }` from scratch would still satisfy a deep-equal check but fail this.
      const androidResult: AttestationVerification = { ok: true }
      const android = new RecordingVerifier(androidResult)
      const dispatcher = new PlatformDispatchingAttestationVerifier(android, new RecordingVerifier({ ok: true }))

      const r = await dispatcher.verify(CHALLENGE, androidAttestation())

      expect(r).to.equal(androidResult)
    })

    it('preserves an Android ok:false result\'s reason string byte-for-byte, unrewritten', async () => {
      const exactReason = 'Play Console key material is not provisioned — see SETUP.md — verbatim test marker éé'
      const androidResult: AttestationVerification = { ok: false, reason: exactReason }
      const android = new RecordingVerifier(androidResult)
      const dispatcher = new PlatformDispatchingAttestationVerifier(android, new RecordingVerifier({ ok: true }))

      const r = await dispatcher.verify(CHALLENGE, androidAttestation())

      expect(r).to.equal(androidResult)
      expect(r.ok).to.equal(false)
      // Character-for-character, not just a substring/pattern match — a "helpful" prefix or suffix
      // added by a re-wrapping dispatcher would still match a loose regex but fail this equality.
      expect(r.reason).to.equal(exactReason)
    })
  })

  // ---- Rule 4: a missing iOS verifier rejects legibly, never crashes, never passes ----
  describe('rule 4 — a missing iOS verifier (2nd constructor arg omitted) is a rejection, not a crash or a pass', () => {
    it('rejects an iOS attestation with a legible reason when constructed with only the Android verifier', async () => {
      const android = new RecordingVerifier({ ok: true })
      const dispatcher = new PlatformDispatchingAttestationVerifier(android)

      const r = await dispatcher.verify(CHALLENGE, iosAttestation())

      expect(r.ok).to.equal(false)
      expect(r.reason).to.be.a('string')
      expect(r.reason).to.match(/no iOS verifier is provisioned/)
    })

    it('does not throw and does not touch the Android verifier while rejecting the unprovisioned iOS attestation', async () => {
      const android = new RecordingVerifier({ ok: true })
      const dispatcher = new PlatformDispatchingAttestationVerifier(android)

      // An awaited throw here fails the test on its own (mocha treats a rejected async `it` as a
      // failure); the explicit `ok:false` check below additionally rules out "crashed instead" being
      // mistaken for a legitimate silent pass.
      const r = await dispatcher.verify(CHALLENGE, iosAttestation())
      expect(r.ok).to.equal(false)
      expect(android.calls).to.have.length(0)
    })
  })
})
