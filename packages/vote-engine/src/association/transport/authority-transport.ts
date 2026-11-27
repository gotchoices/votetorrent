import type { AssociateInit, AttestationChallenge, Signature } from '@votetorrent/vote-core'

/**
 * SUPERSEDED (D-04) for register/associate, effective Phase 51:
 * `IAssociationRequestTransport` (`association-request-transport.ts`)
 * supersedes this seam for that flow. `local-authority-transport.ts`
 * carries the in-process framing this seam was built on — preserved there
 * verbatim, unreworded, because downstream agents are instructed to read
 * it: "the authority peer runs the verifier + engine in-process, NOT as a
 * dedicated backend service."
 *
 * authority-transport.ts — the D-11 producer-to-authority transport seam.
 *
 * Mirrors `IAttestationVerifier`'s doc-comment convention
 * (`vote-core/association/types.ts:52-62`, citing D-07): the real
 * peer-to-peer transport (device producer <-> authority peer) is DEFERRED
 * until the relay-reservation blocker on the P2P substrate clears. This
 * minimal interface exists so the challenge -> produce -> associate
 * round-trip is exercisable end-to-end on Node RIGHT NOW, with NO live P2P
 * dependency — the shape never changes when the real transport plugs in
 * later (D-11).
 *
 * `submitAssociate`'s `signatureOrCallback` parameter matches
 * `IAssociationEngine.associate`'s own union exactly (a real `Signature` OR
 * a digest->Signature callback — D-01/D-19: the engine/transport never
 * holds a raw private key).
 */
type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

export interface IAuthorityTransport {
  /**
   * Deliver a freshly issued `AttestationChallenge` to the producing
   * device. In the real P2P transport this crosses the wire; in
   * `LocalAuthorityTransport` (in-process, D-03) it is a documented no-op
   * because the challenge was already issued in-process by the engine that
   * constructs the transport.
   */
  sendChallenge(challenge: AttestationChallenge): Promise<void>

  /**
   * Submit the device-produced `AssociateInit` (carrying the
   * `DeviceAttestation`) back to the authority for verification + write.
   * Matches `IAssociationEngine.associate(init, signatureOrCallback)`'s
   * signature exactly so a real transport can delegate 1:1 without any
   * shape translation.
   */
  submitAssociate(init: AssociateInit, signatureOrCallback: SignatureOrCallback): Promise<void>
}
