import type { AttestationChallenge, AttestationVerification, DeviceAttestation, IAttestationVerifier } from '@votetorrent/vote-core'
import type { IIntegrityKeyProvider } from './key-provider.js'
import { verifyPlayIntegrity } from './verifiers/play-integrity.js'
import { verifyKeyAttestation, type KeyAttestationRole } from './verifiers/key-attestation.js'
import type { ExpectedAppIdentity } from './verifiers/app-identity.js'
// `Buffer` is NOT a Hermes global (see ../utils.ts) — import it from the `buffer`
// module, which metro.config.js aliases and both apps declare as a dependency.
import { Buffer } from 'buffer'

/**
 * PlayIntegrityVerifier — the real `IAttestationVerifier` implementation
 * (D-01/D-02/D-04/D-06), replacing `StubAttestationVerifier` behind the
 * unchanged seam. Real platform verification, deferred by the stub, lands
 * here: offline classic-API Google Play Integrity decrypt+verify
 * (`verifiers/play-integrity.ts`) composed with offline Android Keystore
 * hardware Key Attestation cert-chain validation
 * (`verifiers/key-attestation.ts`) — D-01 requires BOTH mechanisms to
 * pass; a single passing half never authorizes association. The stub
 * remains the dev-gate fallback (D-14, `USE_STUB_ATTESTATION_VERIFIER`).
 *
 * Never throws for adversarial input — like `StubAttestationVerifier`,
 * every rejection is an early-returned `{ ok: false, reason }` tuple; the
 * caller (`association-engine.ts:255-261`) converts `!ok` into a thrown
 * `Error` itself.
 *
 * **D-09 — key-provisioning fail-closed check, relocated here.** This check
 * formerly lived at construction time in
 * `apps/VoteTorrentAuthority/src/engines/engine-factory.ts:402-406` (a
 * `throw` inside the factory's `'association'` case when
 * `PLAY_CONSOLE_*_KEY_BASE64` build constants were absent). It now lives as
 * the FIRST statement of `verify()`, gated by the `keysProvisioned`
 * constructor parameter below, so that no other rejection reason (e.g. "no
 * Android platform details") can mask an unprovisioned-keys condition — an
 * unprovisioned verifier must always report the provisioning reason first,
 * regardless of what else is wrong with the submitted attestation. The
 * never-throws contract above is unchanged: this is an early-returned
 * `{ ok: false, reason }` tuple, never a `throw`; `association-engine.ts`'s
 * existing `if (!verification.ok) throw` at `:279-283` is what converts
 * this tuple into fail-closed behavior end to end, and that file is not
 * modified by this relocation. `keysProvisioned` defaults to `true` so
 * every existing three-argument construction site keeps constructing a
 * provisioned verifier unchanged — the authority `EngineFactory` is
 * responsible for threading the real `playConsoleKeysProvisioned` value
 * into the 5th argument (47-09).
 */
export class PlayIntegrityVerifier implements IAttestationVerifier {
  constructor (
    private readonly keyProvider: IIntegrityKeyProvider,
    private readonly pinnedHardwareRoots: Uint8Array[],
    private readonly expectedAppIdentity: ExpectedAppIdentity,
    private readonly revokedSerials: Set<string> = new Set<string>(),
    private readonly keysProvisioned: boolean = true
  ) {}

  async verify (challenge: AttestationChallenge, attestation: DeviceAttestation): Promise<AttestationVerification> {
    // D-09 / CR-03: relocated fail-closed check — must be the FIRST statement
    // in this method so an unprovisioned verifier always reports this reason,
    // never a downstream rejection reason that would mask it.
    if (!this.keysProvisioned) {
      return { ok: false, reason: 'Play Console key material is not provisioned — see SETUP.md' }
    }

    const android = attestation.platformDetails?.type === 'Android' ? attestation.platformDetails : undefined
    if (!android) {
      return { ok: false, reason: 'attestation carries no Android platform details' }
    }

    const piResult = await verifyPlayIntegrity(android.safetyNetAttestation, challenge, this.keyProvider, this.expectedAppIdentity)
    if (!piResult.ok) return piResult

    const toDer = (chain: string[]): Uint8Array[] => chain.map((cert) => new Uint8Array(Buffer.from(cert, 'base64')))
    const verifyChain = (chain: string[], role: KeyAttestationRole) =>
      verifyKeyAttestation(toDer(chain), challenge, this.pinnedHardwareRoots, this.revokedSerials, this.expectedAppIdentity, role)

    // Spike 104 (R1d): the voting key's own chain, when present, proves the voting key is
    // hardware-backed; `certificateChain` then belongs to the throwaway key that answered the nonce.
    // Both must pass. The requester key's signature over the whole answer (checked engine-side in
    // `validateStagedAttestationAnswer`) is what ties the two chains to one holder.
    if (android.deviceKeyCertificateChain !== undefined) {
      const deviceKeyResult = await verifyChain(android.deviceKeyCertificateChain, 'device-key')
      if (!deviceKeyResult.ok) return { ok: false, reason: `device-key chain: ${deviceKeyResult.reason ?? 'rejected'}` }
      const freshResult = await verifyChain(attestation.certificateChain, 'fresh')
      if (!freshResult.ok) return { ok: false, reason: `nonce-bound chain: ${freshResult.reason ?? 'rejected'}` }
      return { ok: true }
    }

    const keyAttResult = await verifyChain(attestation.certificateChain, 'single')
    if (!keyAttResult.ok) return keyAttResult

    return { ok: true }
  }
}
