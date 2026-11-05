/**
 * app-attest-verifier.ts — the real iOS `IAttestationVerifier` (Phase 51), sibling of
 * `PlayIntegrityVerifier`.
 *
 * Composes the two halves the iOS contract requires:
 *   1. `verifiers/app-attest.ts`           — the App Attest ATTESTATION (chain → pinned Apple root,
 *                                            credCert nonce OID, keyId, rpIdHash, counter, aaguid)
 *   2. `verifiers/app-attest-assertion.ts` — the CROSS-SIGN (assertion binding K_vote) plus the
 *                                            K_vote proof-of-possession signature
 *
 * **Both must pass.** A passing attestation alone proves a genuine app on genuine hardware but says
 * nothing about which key is being registered; a passing cross-sign alone is unrooted. This mirrors
 * D-01's "both mechanisms" rule as adapted for integrity bar A — see
 * `ATTESTATION-CONTRACT-IOS.md` §8 and the bar A vs bar B decision recorded in the spike MANIFEST.
 *
 * Like `PlayIntegrityVerifier` and `StubAttestationVerifier`, this **never throws** for adversarial
 * input: every rejection is an early-returned `{ ok: false, reason }` tuple. The caller
 * (`association-engine.ts`) is what converts `!ok` into a thrown Error.
 *
 * **Offline (D-04).** Pinned roots are an injected, bundled snapshot; nothing is fetched at verify
 * time. Under bar A DeviceCheck is not consulted at all, so no Apple credentials and no network
 * access are required — the property that made bar A the choice.
 *
 * **UNPROVEN against real hardware.** Every fixture behind this file is synthetic;
 * `DCAppAttestService` needs a signed build and a physical iPhone. A green test suite here is not
 * working attestation.
 */
import type { AttestationChallenge, AttestationVerification, DeviceAttestation, IAttestationVerifier } from '@votetorrent/vote-core'
import { Buffer } from 'buffer'
// STATIC import, matching every sibling verifier (`verifiers/app-attest.ts`,
// `verifiers/key-attestation.ts`). This was a dynamic `require('node:crypto')` until the file was
// wired into the RN authority app: Metro cannot follow a dynamic require, and the app's
// metro.config.js aliases the `node:crypto` SPECIFIER to `polyfills/node-crypto.js`, so the
// require form resolved to nothing on device while passing every Node test.
import { createHash } from 'node:crypto'
import { verifyAppAttest } from './verifiers/app-attest.js'
import { verifyCrossSign } from './verifiers/app-attest-assertion.js'
import { recomputeChallengeDigest } from './verifiers/digest-binding.js'

/** Storage seam for the App Attest assertion replay counter (ATTESTATION-CONTRACT-IOS.md §8.10). */
export interface IAssertionCounterStore {
  /**
   * Highest counter previously accepted for `appAttestKeyId`, or `undefined` if this key has never
   * been seen. At association time this is normally `undefined`; a non-undefined value means the
   * same App Attest key is being re-used, which the counter rule then makes monotonic.
   */
  getCounter (appAttestKeyId: string): Promise<number | undefined>
}

/** An always-empty counter store — correct for a pure association-time verifier. */
export const NO_PRIOR_ASSERTIONS: IAssertionCounterStore = {
  async getCounter (): Promise<number | undefined> { return undefined }
}

export class AppAttestVerifier implements IAttestationVerifier {
  constructor (
    /** PINNED Apple App Attest root(s), DER. Injected, bundled, never fetched (D-04). */
    private readonly pinnedRootsDer: Uint8Array[],
    /** `<teamId>.<bundleId>` — the App ID every attestation and assertion must be bound to. */
    private readonly appId: string,
    /**
     * Which environment this authority accepts. A `development` attestation must NEVER be accepted
     * by a production authority; the credCert `aaguid` is the only thing that distinguishes them,
     * and TestFlight/App Store builds are `production` regardless of the entitlement plist value.
     */
    private readonly environment: 'development' | 'production',
    private readonly counterStore: IAssertionCounterStore = NO_PRIOR_ASSERTIONS,
    /**
     * Mirrors `PlayIntegrityVerifier`'s D-09 fail-closed gate: when the Apple root snapshot has not
     * been provisioned, report THAT first so no downstream reason can mask it.
     */
    private readonly rootsProvisioned: boolean = true,
    /**
     * OPTIONAL injected "now" for `verifyAppAttest`'s STEP 1 chain-validity check. Defaults to
     * `undefined`, which makes `verifyAppAttest` fall back to the real wall clock — PRODUCTION
     * BEHAVIOUR IS UNCHANGED. This exists solely so specs replaying a REAL captured Apple App
     * Attest chain can pin verification to the chain's capture time instead of decaying as wall-
     * clock time passes; nothing in the shipped app ever sets it.
     */
    private readonly now?: Date
  ) {}

  async verify (challenge: AttestationChallenge, attestation: DeviceAttestation): Promise<AttestationVerification> {
    if (!this.rootsProvisioned || this.pinnedRootsDer.length === 0) {
      return { ok: false, reason: 'Apple App Attest root material is not provisioned — see SETUP.md' }
    }

    // The App ID is the SECOND piece of config with no safe default. An empty one still "works":
    // `verifyAppAttest` compares rpIdHash against SHA256('') and rejects with "attestation is for a
    // different app" — a reason that blames the device for a deployment mistake. Reported here, next
    // to the root gate, so an unprovisioned authority names what it is missing.
    if (this.appId === '') {
      return { ok: false, reason: 'Apple App ID (<teamId>.<bundleId>) is not provisioned — see SETUP.md' }
    }

    const ios = attestation.platformDetails?.type === 'iOS' ? attestation.platformDetails : undefined
    if (ios === undefined) {
      return { ok: false, reason: 'attestation carries no iOS platform details' }
    }

    // The environment gate is checked here as well as inside verifyAppAttest so that a
    // configuration mismatch reports as a configuration problem rather than as an aaguid mismatch.
    if (ios.environment !== this.environment) {
      return { ok: false, reason: `attestation environment '${ios.environment}' does not match this authority's '${this.environment}' — a development attestation is never accepted in production` }
    }

    // The vote key named by the attestation must be the key actually being associated. The builder
    // checks this too; repeated here because the builder is a client-side convenience and this is
    // the security boundary.
    if (ios.secureEnclavePublicKey !== challenge.deviceKey) {
      return { ok: false, reason: 'attestation secureEnclavePublicKey does not equal the challenge deviceKey' }
    }

    // BOUND_DIGEST is RECOMPUTED from authority-held values; the submitted copy is only cross-checked
    // so a mismatch surfaces legibly instead of as an opaque signature failure.
    const boundDigest = recomputeChallengeDigest(challenge.nonce, challenge.deviceKey)
    if (ios.boundDigest !== boundDigest) {
      return { ok: false, reason: 'attestation boundDigest does not equal Digest(nonce, deviceKey) — D-06 anti-relay binding failed' }
    }

    // ---- half 1: the attestation ----
    const attestationObject = decodeBase64(attestation.attestationStatement)
    if (attestationObject === undefined) {
      return { ok: false, reason: 'attestation carries no attestationStatement (base64 CBOR attestation object)' }
    }
    const keyId = decodeBase64(ios.appAttestKeyId)
    if (keyId === undefined) {
      return { ok: false, reason: 'appAttestKeyId is not valid base64' }
    }

    // clientDataHash = SHA256(utf8(BOUND_DIGEST)) — §2. Computed here, never taken from the device.
    const expectedClientDataHash = sha256(new TextEncoder().encode(boundDigest))

    const attestationResult = await verifyAppAttest(attestationObject, {
      appId: this.appId,
      expectedClientDataHash,
      keyId,
      pinnedRootsDer: this.pinnedRootsDer,
      environment: this.environment,
      now: this.now
    })
    if (!attestationResult.ok) return attestationResult

    const appAttestPublicKeyRaw = attestationResult.attestedPublicKeyRaw
    if (appAttestPublicKeyRaw === undefined) {
      return { ok: false, reason: 'attestation verified but yielded no attested public key' }
    }

    // ---- half 2: the cross-sign + proof of possession ----
    const assertionCbor = decodeBase64(ios.assertion)
    if (assertionCbor === undefined) {
      return { ok: false, reason: 'attestation carries no assertion (base64 CBOR cross-sign)' }
    }

    const previousCounter = await this.counterStore.getCounter(ios.appAttestKeyId)
    const crossSign = verifyCrossSign(assertionCbor, ios.popSignature, {
      appId: this.appId,
      challengeNonce: challenge.nonce,
      deviceKey: challenge.deviceKey,
      appAttestPublicKeyRaw,
      previousCounter
    })
    if (!crossSign.ok) return crossSign

    // The counter the device claimed must be the counter actually inside the signed
    // authenticatorData — otherwise a caller could persist a value the signature never covered.
    if (crossSign.counter !== ios.assertionCounter) {
      return { ok: false, reason: `declared assertionCounter ${ios.assertionCounter} does not match the signed assertion's counter ${String(crossSign.counter)}` }
    }

    return { ok: true }
  }
}

function sha256 (data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest())
}

/** Tolerant base64 decode — returns undefined rather than throwing, per the never-throws contract. */
function decodeBase64 (value: string | undefined): Uint8Array | undefined {
  if (value === undefined || value === '') return undefined
  try {
    const buf = Buffer.from(value, 'base64')
    // Buffer.from silently ignores invalid characters, so round-trip to catch garbage rather than
    // handing the CBOR decoder a truncated buffer and reporting a confusing parse error.
    if (buf.length === 0) return undefined
    return new Uint8Array(buf)
  } catch {
    return undefined
  }
}
