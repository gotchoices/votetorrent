import type { AssociationAttestationAnswer, AssociationRequestInit, AssociationRequestStatus, Signature } from '@votetorrent/vote-core'

/**
 * association-request-transport.ts — the D-08/D-18 authority-association-request
 * transport seam.
 *
 * `authority-transport.ts` / `local-authority-transport.ts` (the D-11
 * producer-to-authority seam these files' shape is modeled on) were written
 * assuming exactly ONE real binding today plus a hypothetical future one —
 * "the shape never changes when the real transport plugs in later." It
 * proved exactly one binding, and (D-04) is now superseded for THIS flow.
 *
 * **D-08 explicitly rejects that "prove one, add more later" framing.**
 * `IAssociationRequestTransport` requires **two real bindings from day
 * one** — a filesystem drop-file binding and a pull-based REST binding,
 * both named in `doc/registration.md:12`, both P2P-free, both exercised by
 * **one shared conformance suite with identical assertions**. Two
 * interchangeable bindings are what make this an abstraction rather than a
 * speculative indirection; one binding would prove only that the interface
 * compiles.
 *
 * A **third**, peer-cluster binding may be written and is
 * **reserved-and-skipped**: it never counts toward a pass and its failure
 * gates nothing. **Node and jest results are not verification for it** —
 * this project has repeatedly had "implemented but unproven" read as
 * "done."
 *
 * Security property: a transport receives either a completed `Signature` or
 * a digest->`Signature` callback, and **NEVER a raw private key**, on BOTH
 * legs (`submitRequest` and `submitAttestation`) — matching
 * `IAssociationEngine`'s own methods exactly. A binding that crosses a
 * process, a filesystem, or a network therefore never has key material to
 * leak (D-01/D-08).
 *
 * D-18: association is NOT single-round-trip the way registration is. The
 * authority must hand the device a nonce BEFORE the device can attest,
 * because the nonce is bound INTO the attestation itself. This seam
 * therefore carries a distinct second voter-to-authority message,
 * `submitAttestation`, rather than a widened `submitRequest` with an
 * optional payload — the self-signed ask and the self-signed
 * attestation-answer assert structurally different things with different
 * validity rules, and the shared conformance suite asserts each SEPARATELY.
 *
 * This comment makes no claim that the `'vrg'` scope is enforced anywhere in
 * this seam.
 */
type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/**
 * D-18/D-19: a notification that a submitted association request reached a
 * challenge-issued, terminal, or otherwise updated state, delivered to a
 * binding via `pollDecisions`. `status` reuses the vote-core
 * `AssociationRequestStatus` union so a binding cannot invent a fifth status
 * code. `challengeNonce` is present ONLY on a `'c'` (challenge issued)
 * notice — it is how the voter learns the nonce it must attest against.
 * `reason` is present only on a `'r'` (rejected) notice.
 */
export interface AssociationDecisionNotice {
  requestId: string
  status: AssociationRequestStatus
  challengeNonce?: string
  reason?: string
  /**
   * A resume cursor, not a row identifier: forward the last value as `sinceCursor` to continue
   * (re-delivery is permitted, loss is not). Opaque; compare for equality only. In the P2P binding
   * a decision above the in-sequence ceiling carries the last in-sequence cursor of the read (else
   * the caller's conforming `sinceCursor`, else the re-read sentinel `0000000000000000`), so
   * several notices can share one value and it can differ from the cursor `publishDecision`
   * returned. See `readDecisionRows` in `p2p-staging-seam.ts`.
   */
  cursor: string
}

/**
 * WR-10: the closed vote-core `AssociationRequestStatus` union, expressed
 * once, HERE, on the seam itself — mirroring the registration seam's
 * `KNOWN_REGISTRATION_STATUS_CODES` pattern. Four codes, not registration's
 * three, because of `'c'` (challenge issued).
 *
 * Why it belongs on the seam rather than in one binding: D-08's whole claim
 * is "one shared conformance suite with identical assertions" across the
 * bindings. WR-10's recorded history on the registration seam: two of three
 * bindings coerced instead of checked (`status as RegistrationRequestStatus`
 * after a bare `typeof === 'string'`, or with no check at all), so a drop
 * file or a strand row carrying an unknown code flowed through as a
 * well-typed decision notice and every downstream `switch (notice.status)`
 * silently took no branch — a silent drop of a DECISION, which is the one
 * thing this seam's own contract says must never be lost ("re-delivery is
 * permitted; loss is not").
 *
 * Why a THROW and not a skip: a code outside this set means the producer and
 * the schema disagree about the vocabulary. That is not a malformed row to
 * step over — it will mis-decide every subsequent notice from the same
 * producer too, so it must be surfaced.
 */
export const KNOWN_ASSOCIATION_STATUS_CODES: ReadonlySet<string> = new Set(['p', 'c', 'a', 'r'])

/**
 * WR-10: the single narrowing helper every binding routes an untrusted
 * `status` value through. `where` is a caller-supplied prefix (e.g.
 * `'RestAssociationTransport.pollDecisions'`) so the thrown error still
 * names the binding that produced it. The message carries the offending
 * status value and NOTHING else — no document body, no filename, no
 * requester field (the never-log rule each of these transports states in
 * its own header).
 */
export function assertKnownAssociationStatus (status: unknown, where: string): AssociationRequestStatus {
  if (typeof status !== 'string' || !KNOWN_ASSOCIATION_STATUS_CODES.has(status)) {
    throw new Error(`${where}: decision notice carries a status outside the vote-core union: ${JSON.stringify(status)}`)
  }
  return status as AssociationRequestStatus
}

export interface IAssociationRequestTransport {
  /**
   * Submit an association request through this binding. The parameter list
   * matches `IAssociationEngine.submitAssociationRequest` exactly so a
   * binding can delegate 1:1 with no shape translation.
   *
   * A binding copies `init.submittedAt` through **verbatim and without
   * interpretation**: it is the submitter's own signing-time timestamp and
   * the sixth argument of the digest the engine will verify at INSERT
   * (51-01's recorded `SignatureValid` digest order). A binding that
   * regenerates, normalizes, or re-formats it invalidates the signature it
   * is couriering, and the failure surfaces at INSERT — a layer away from
   * its cause.
   */
  submitRequest(init: AssociationRequestInit, requesterKey: string, signatureOrCallback: SignatureOrCallback): Promise<string>

  /**
   * D-18 — the distinct second leg. The self-signed ask (`submitRequest`)
   * and the self-signed attestation-answer (`submitAttestation`) assert
   * structurally different things with different validity rules; this is
   * NOT a widened `submitRequest` carrying an optional payload, and NOT a
   * second request table. The conformance suite asserts each method
   * SEPARATELY.
   */
  submitAttestation(answer: AssociationAttestationAnswer, requesterKey: string, signatureOrCallback: SignatureOrCallback): Promise<void>

  /**
   * Pull model — the authority calls out and polls; it does not host an
   * inbound webhook receiver, because React Native cannot reliably run a
   * persistent background HTTP listener and an inbound port on a NAT'd
   * mobile device is an attack surface with no way to close it. If a genuine
   * push receiver is ever wanted it belongs in a standalone Node service,
   * not the app bundle.
   *
   * `cursor` advances monotonically and a binding must be safe to call with
   * a stale cursor — re-delivery is permitted; loss is not.
   */
  pollDecisions(sinceCursor?: string): Promise<AssociationDecisionNotice[]>
}
