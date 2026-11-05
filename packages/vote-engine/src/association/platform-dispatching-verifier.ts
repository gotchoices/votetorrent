/**
 * platform-dispatching-verifier.ts — the seam spike 080 (P1) showed iOS support requires.
 *
 * `PlayIntegrityVerifier` hard-gates on `platformDetails?.type === 'Android'` and returns
 * `{ok:false}` for everything else. That is correct fail-closed behaviour and must NOT be edited:
 * an Android verifier that also "handles" iOS is how platform confusion bugs get written. Instead
 * this decorator sits in front, routes by platform, and delegates.
 *
 * Design rules (each one exists because of a specific way this goes wrong):
 *  1. **Fail closed on the default branch.** An unrecognised or ABSENT platform is rejected, never
 *     passed through. A new platform added to the union must not silently become "allowed".
 *  2. **Never let one platform's verifier see another platform's attestation.** Routing happens
 *     once, up front, on the discriminant.
 *  3. **Delegation is verbatim.** The Android path returns the Android verifier's own result tuple
 *     unmodified — no re-wrapping, no reason rewriting — so existing Android behaviour and its
 *     rejection reasons are bit-for-bit preserved (asserted by the harness's regression cases).
 *  4. **A missing iOS verifier is a rejection, not a crash and not a pass.** Deployments that have
 *     not provisioned iOS support must reject iOS attestations with a legible reason.
 */
import type { AttestationChallenge, AttestationVerification, DeviceAttestation, IAttestationVerifier } from '@votetorrent/vote-core'

export class PlatformDispatchingAttestationVerifier implements IAttestationVerifier {
  constructor (
    private readonly androidVerifier: IAttestationVerifier,
    private readonly iosVerifier?: IAttestationVerifier
  ) {}

  async verify (challenge: AttestationChallenge, attestation: DeviceAttestation): Promise<AttestationVerification> {
    const platform = attestation.platformDetails?.type

    switch (platform) {
      case 'Android':
        // Rule 3: verbatim delegation — do not touch the result.
        return await this.androidVerifier.verify(challenge, attestation)

      case 'iOS':
        if (this.iosVerifier === undefined) {
          // Rule 4.
          return { ok: false, reason: 'iOS attestation received but no iOS verifier is provisioned' }
        }
        return await this.iosVerifier.verify(challenge, attestation)

      default:
        // Rule 1. Covers both `undefined` (no platform details at all) and any future/unknown tag.
        return {
          ok: false,
          reason: platform === undefined
            ? 'attestation carries no platform details'
            : `unsupported attestation platform: ${String(platform)}`
        }
    }
  }
}
