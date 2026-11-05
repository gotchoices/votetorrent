import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { AssociationAssociateBuilder } from './builders/association-associate-builder.js'
import {
  REASSOCIATION_NOT_APPROVED_REASON,
  encodeRegistrationCodeBits
} from '@votetorrent/vote-core'
import type {
  AssociateInit,
  Association,
  AssociationAttestationAnswer,
  AssociationRequestInit,
  AssociationRequestRead,
  AssociationRequestStatus,
  AttestationChallenge,
  AttestationVerdict,
  AttestationVerification,
  DeviceRetirement,
  IAssociationAssociateBuilder,
  IAssociationEngine,
  IReassociationEngine,
  ReassociationApprovalInput,
  ReassociationApprovalResult,
  ReassociationDecisionSource,
  ReassociationIntake,
  ReassociationOpener,
  ReassociationProcessingSummary,
  ReassociationRejectionResult,
  ReassociationReview,
  ReassociationSignatureOrCallback,
  Signature
} from '@votetorrent/vote-core'

type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/** Construction-time knobs for the mock's divergences from the real engine. */
export interface MockAssociationEngineOptions {
  /**
   * Whether `associate()` records a verdict at all — the mock's stand-in for
   * `ElectionAttestationPolicy.AttestationRequired` (47-REVIEW IN-04).
   *
   * The real engine records NO verdict when `AttestationRequired = 0`
   * (`association-engine.ts`), which per Phase 45 D-14a is the common
   * non-attested path and the exact state `VerdictBadge`'s "none" branch
   * exists for. The mock holds no policy store, so it cannot derive this
   * itself; without this knob the "none" state was unreachable from any
   * mock-driven screen test, and a screen test could wrongly conclude the
   * "none" badge was dead code.
   *
   * Defaults to `true` — the pre-existing behaviour, so no existing caller
   * changes.
   */
  attestationRequired?: boolean
}

/**
 * MockAssociationEngine — UI-layer-only, in-memory parity implementation of
 * `IAssociationEngine` (D-01). Mirrors `MockElectionsEngine`'s `Map`-keyed
 * shape (elections/mock-elections-engine.ts) and `MockRegistrationEngine`'s
 * DEBT-02 conventions — no DB, no real signing.
 *
 * Challenges are keyed by `Nonce`; associations are keyed by
 * `${registrantId}:${deviceKey}` — a second `associate()` for the same key
 * throws (mock replay parity, matching the real engine's Association PK
 * collision behavior for D-06 replay).
 *
 * DECLARED DIVERGENCES from the real engine — both about `associate()`'s
 * verdict write, both stated here so no screen test infers a false invariant
 * from a green mock-driven run:
 *   1. The mock holds no `IAttestationVerifier`, so a verdict it records is
 *      always `'pass'`. Fail-path parity is proven against the REAL engine
 *      only.
 *   2. The mock holds no `ElectionAttestationPolicy`, so whether a verdict is
 *      recorded AT ALL comes from `options.attestationRequired` rather than
 *      from the policy row. Pass `{ attestationRequired: false }` to reproduce
 *      the real engine's `AttestationRequired = 0` path — association written,
 *      no verdict row — which is `VerdictBadge`'s "none" state.
 */
export class MockAssociationEngine implements IAssociationEngine, IReassociationEngine {
  private readonly challenges = new Map<string, AttestationChallenge>()
  private readonly associations = new Map<string, Association>()
  /**
   * D-02/D-18 mock parity — keyed by requestId. Both `submitAssociationRequest` and
   * `submitAssociationAttestation` below verify no signature, enforce no CHECK, and apply no
   * skew bound (the mock's declared blind spot — real enforcement is proven only against
   * `AssociationEngine`'s schema-backed CHECKs, e.g. `association-request.spec.ts`). This map
   * also stands in for the real engine's `pendingAttestationAnswers` staging map.
   */
  private readonly associationRequests = new Map<string, AssociationRequestRead>()
  private readonly stagedAttestationAnswers = new Map<string, AssociationAttestationAnswer>()
  /** D-03 in-memory parity — append-only, ordered; an array (not a Map) mirrors the real store's shape. */
  private readonly verdicts: AttestationVerdict[] = []
  private readonly attestationRequired: boolean

  constructor (options?: MockAssociationEngineOptions) {
    this.attestationRequired = options?.attestationRequired ?? true
  }

  async issueAttestationChallenge (
    registrantId: string,
    deviceKey: string,
    _signatureOrCallback: SignatureOrCallback,
    electionId?: string
  ): Promise<AttestationChallenge> {
    const nonce = crypto.randomUUID()
    const challenge: AttestationChallenge = {
      nonce,
      authorityId: 'mock-authority',
      registrantId,
      deviceKey,
      electionId
    }
    this.challenges.set(nonce, challenge)
    return challenge
  }

  async removeAttestationChallenge (nonce: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.challenges.delete(nonce)
  }

  async getAttestationChallenges (registrantId?: string): Promise<AttestationChallenge[]> {
    return [...this.challenges.values()].filter((c) => registrantId === undefined || c.registrantId === registrantId)
  }

  buildAssociate (): IAssociationAssociateBuilder {
    return new AssociationAssociateBuilder(this)
  }

  async associate (init: AssociateInit, signatureOrCallback: SignatureOrCallback): Promise<void> {
    const key = `${init.registrantId}:${init.deviceKey}`
    if (this.associations.has(key)) {
      throw new Error(`MockAssociationEngine.associate: an Association already exists for ${key} (mock replay parity — D-06)`)
    }
    const sig = typeof signatureOrCallback === 'function'
      ? await signatureOrCallback(new Uint8Array())
      : signatureOrCallback
    this.associations.set(key, {
      registrantId: init.registrantId,
      deviceKey: init.deviceKey,
      deviceHash: init.deviceHash,
      attestationCid: `mock-attestation-cid-${key}`,
      // D-10 (51-05): AttestationChallenge no longer carries an expiration to reuse; the mock
      // stands in with a fixed 1-hour window (it holds no ElectionRecordValidityPolicy store).
      expiration: new Date(Date.now() + 3_600_000).toISOString(),
      signorKey: sig.signerKey,
      signature: sig.signature
    })
    // The policy gate, standing in for ElectionAttestationPolicy.
    // AttestationRequired (see the class doc's divergence 2): when false, the
    // association is written and NO verdict row is — the real engine's
    // AttestationRequired = 0 path, and VerdictBadge's "none" state.
    if (!this.attestationRequired) return
    // The mock holds no IAttestationVerifier (see recordAttestationVerdict
    // below) and therefore can only ever record a 'pass' verdict here — no
    // screen may infer from the mock that a 'fail' verdict is unreachable.
    // Fail-path parity is proven against the REAL engine only.
    await this.recordAttestationVerdict(init.registrantId, init.deviceKey, { ok: true })
  }

  async getAssociation (registrantId: string, deviceKey: string): Promise<Association | undefined> {
    return this.associations.get(`${registrantId}:${deviceKey}`)
  }

  async getAssociations (registrantId: string): Promise<Association[]> {
    return [...this.associations.values()].filter((a) => a.registrantId === registrantId)
  }

  /** D-23a mock parity — filters by device key; sorted copy (never the internal Map by reference) to match the real engine's `registrantId`-ascending ordering. */
  async getAssociationsByDeviceKey (deviceKey: string): Promise<Association[]> {
    return [...this.associations.values()]
      .filter((a) => a.deviceKey === deviceKey)
      .sort((a, b) => (a.registrantId < b.registrantId ? -1 : a.registrantId > b.registrantId ? 1 : 0))
  }

  async removeAssociation (registrantId: string, deviceKey: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.associations.delete(`${registrantId}:${deviceKey}`)
  }

  /** D-03 mock parity — no signature parameter, matching the real engine's unsigned (D-02) shape. */
  async recordAttestationVerdict (registrantId: string, deviceKey: string, verification: AttestationVerification): Promise<void> {
    const sequence = this.verdicts.filter((v) => v.registrantId === registrantId && v.deviceKey === deviceKey).length
    this.verdicts.push({
      registrantId,
      deviceKey,
      sequence,
      verdict: verification.ok ? 'pass' : 'fail',
      reason: verification.reason,
      verifiedAt: new Date().toISOString()
    })
  }

  /** D-03 mock parity — mutates nothing; returns a sorted copy, never the internal array by reference. */
  async getAttestationVerdicts (registrantId: string, deviceKey?: string): Promise<AttestationVerdict[]> {
    return this.verdicts
      .filter((v) => v.registrantId === registrantId && (deviceKey === undefined || v.deviceKey === deviceKey))
      .sort((a, b) => (a.deviceKey < b.deviceKey ? -1 : a.deviceKey > b.deviceKey ? 1 : a.sequence - b.sequence))
  }

  // ---------- 51-04: stub bodies for the widened IAssociationEngine ----------
  // 51-08/51-09 own mock parity — a half-real mock that silently succeeds here
  // would be worse than one that throws.

  /**
   * D-02 mock parity — verifies no signature, enforces no CHECK, applies no skew bound. Stores
   * the row in-memory (keyed by `init.id`) so a mock-driven screen test has something to read
   * back; real enforcement (zero-ceremony INSERT, skew window, mixed-curve SignatureValid) is
   * proven only against the real `AssociationEngine` (`association-request.spec.ts`). Never
   * calls `signatureOrCallback` and fabricates no `Signature`.
   */
  async submitAssociationRequest (init: AssociationRequestInit, requesterKey: string, _signatureOrCallback: SignatureOrCallback): Promise<string> {
    this.associationRequests.set(init.id, {
      requestId: init.id,
      authorityId: init.authorityId,
      registrantId: init.registrantId,
      deviceKey: requesterKey,
      electionId: init.electionId,
      status: 'p',
      submittedAt: init.submittedAt,
      receivedAt: new Date().toISOString()
    })
    return init.id
  }

  /**
   * D-18 mock parity — verifies no signature, enforces no CHECK, applies no skew bound. Unlike
   * `AssociationEngine.submitAssociationAttestation`, this does NOT re-validate `Status`/
   * `ChallengeNonce`/`requesterKey` against the stored request (the mock's declared blind spot —
   * see class doc). Stages the answer in-memory; never calls `signatureOrCallback` and
   * fabricates no `Signature`.
   */
  async submitAssociationAttestation (answer: AssociationAttestationAnswer, _requesterKey: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.stagedAttestationAnswers.set(answer.requestId, answer)
  }

  /**
   * D-05/D-19 mock parity — unlike the real engine, the mock holds NO `IAssociationRequestIntake`
   * (it has no filesystem/REST transport at all): it drives directly off its own in-memory
   * `associationRequests`/`stagedAttestationAnswers` maps, so this method's signature stays the
   * narrower 2-arg `IAssociationEngine` shape verbatim (no widening needed here — the widening is
   * specific to the real engine's transport-agnostic-but-engine-layer `IAssociationRequestIntake`
   * dependency; see `association-engine.ts`'s doc comment). Never calls `signatureOrCallback` for
   * verification (the mock enforces no CHECK and applies no skew bound — the class doc's declared
   * blind spot), and always records a `'pass'` verdict (mock parity divergence 1).
   */
  async processPendingAssociationRequests (authorityId: string, signatureOrCallback: SignatureOrCallback): Promise<{ challengesIssued: number; associated: number; rejected: number }> {
    let challengesIssued = 0
    let associated = 0
    let rejected = 0

    for (const [requestId, request] of this.associationRequests) {
      if (request.authorityId !== authorityId || request.status !== 'p') continue
      // WR-04 (51-REVIEW): publish the nonce the challenge ACTUALLY carries. This used to mint a
      // second, unrelated UUID and discard `issueAttestationChallenge`'s return value, so the
      // request's `challengeNonce` and `getAttestationChallenges()` never agreed — inverting the
      // one invariant the real engine enforces (`association-engine.ts`:
      // `answer.nonce !== challengeNonce` -> throw). A screen driven by the mock could pair the
      // two, pass here, and fail against the real engine.
      const challenge = await this.issueAttestationChallenge(request.registrantId, request.deviceKey, signatureOrCallback, request.electionId)
      this.associationRequests.set(requestId, { ...request, status: 'c', challengeNonce: challenge.nonce })
      challengesIssued++
    }

    for (const [requestId, answer] of this.stagedAttestationAnswers) {
      const request = this.associationRequests.get(requestId)
      if (!request || request.authorityId !== authorityId || request.status !== 'c') continue
      try {
        await this.associate(
          { registrantId: request.registrantId, deviceKey: request.deviceKey, deviceHash: answer.deviceHash, nonce: request.challengeNonce ?? answer.nonce, attestation: answer.attestation },
          signatureOrCallback
        )
        this.associationRequests.set(requestId, { ...request, status: 'a', decidedAt: new Date().toISOString() })
        associated++
      } catch {
        // GENERIC rejection reason — mock parity with the real engine's never-leak-a-verifier-
        // reason discipline (T-51-09-03).
        this.associationRequests.set(requestId, { ...request, status: 'r', decidedAt: new Date().toISOString(), rejectionReason: 'attestation-verification-failed' })
        rejected++
      }
    }

    return { challengesIssued, associated, rejected }
  }

  /** D-06 mock parity — filters the in-memory map; no signature verification, no ordering guarantee beyond Map insertion order. */
  async listAssociationRequests (authorityId: string, status?: AssociationRequestStatus): Promise<AssociationRequestRead[]> {
    return [...this.associationRequests.values()].filter((r) => r.authorityId === authorityId && (status === undefined || r.status === status))
  }

  /** D-06 mock parity — returns `undefined` for an unknown id rather than throwing. */
  async getAssociationRequest (requestId: string): Promise<AssociationRequestRead | undefined> {
    return this.associationRequests.get(requestId)
  }

  // ---------- 62-18: IReassociationEngine mock parity ----------
  // The mock holds no schema, no intake transport and no opener — every re-association method is
  // SEEDED (a screen test wires in exactly the review/retirement shape it needs) rather than
  // derived from staged rows. `approveReassociation`/`rejectReassociation` record their own calls
  // (`approvedReassociations`/`rejectedReassociations`) so a screen test can assert the officer
  // action actually happened, without a real schema to read back.

  private readonly reassociationReviews = new Map<string, ReassociationReview>()
  private readonly deviceRetirements = new Map<string, DeviceRetirement>()
  /** Recorded `{requestId, registrantId}` pairs, in call order — mock parity for a screen test
   * asserting an approval happened (no real AssociationRequest row exists to read back). */
  readonly approvedReassociations: Array<{ requestId: string; registrantId: string }> = []
  /** Recorded `requestId`s, in call order. */
  readonly rejectedReassociations: string[] = []

  /** Seeds a review `listPendingReassociations`/`getReassociationReview` will return. */
  seedReassociationReview (review: ReassociationReview): void {
    this.reassociationReviews.set(review.requestId, review)
  }

  /** Seeds a retirement `getDeviceRetirement` will return for `retirement.deviceKey`. */
  seedDeviceRetirement (retirement: DeviceRetirement): void {
    this.deviceRetirements.set(retirement.deviceKey, retirement)
  }

  /**
   * D-01 mock parity — never reads `sign`'s private key (there is none to read: a callback is the
   * only key input). Not reproducible against the REAL engine's derivation (that requires the
   * same PRF this mock does not implement) — documented as a mock-only divergence, same
   * discipline as `associate()`'s always-pass-verdict note in this class's own header.
   */
  async deriveRegistrationCode (registrantId: string, _sign: (digest: Uint8Array) => Promise<Signature>): Promise<string> {
    return encodeRegistrationCodeBits(sha256(utf8ToBytes(`mock-reassociation-code:${registrantId}`)))
  }

  /** Mock parity — no registration-request store; always undefined. */
  async getRegistrationCodeHolderKey (_registrantId: string): Promise<string | undefined> {
    return undefined
  }

  /** Mock parity — never drives a real sync; reports every seeded review as still awaiting. */
  async processPendingReassociations (
    _authorityId: string,
    _signatureOrCallback: ReassociationSignatureOrCallback,
    _intake: ReassociationIntake,
    _opener: ReassociationOpener
  ): Promise<ReassociationProcessingSummary> {
    return { challengesIssued: 0, associated: 0, rejected: 0, awaitingReview: this.reassociationReviews.size }
  }

  async listPendingReassociations (
    _authorityId: string,
    _intake: ReassociationIntake,
    _opener: ReassociationOpener
  ): Promise<ReassociationReview[]> {
    return [...this.reassociationReviews.values()]
  }

  async getReassociationReview (
    requestId: string,
    _intake: ReassociationIntake,
    _opener: ReassociationOpener,
    _options?: { readonly registrantId?: string }
  ): Promise<ReassociationReview | undefined> {
    return this.reassociationReviews.get(requestId)
  }

  /** Mock parity — records the call; never verifies the threshold, the evidence, or issues a real
   * challenge (there is no schema to issue one against). */
  async approveReassociation (
    requestId: string,
    input: ReassociationApprovalInput,
    _signatureOrCallback: ReassociationSignatureOrCallback,
    _intake: ReassociationIntake,
    _opener: ReassociationOpener
  ): Promise<ReassociationApprovalResult> {
    this.approvedReassociations.push({ requestId, registrantId: input.registrantId })
    const review = this.reassociationReviews.get(requestId)
    return {
      requestId,
      registrantId: input.registrantId,
      matchMethod: review?.matchMethod ?? 'identity',
      devicesToRetire: review?.existingDevices.map((a) => a.deviceKey) ?? [],
      challengeNonce: crypto.randomUUID(),
      outcome: 'awaiting-device-attestation'
    }
  }

  async rejectReassociation (
    requestId: string,
    _signatureOrCallback: ReassociationSignatureOrCallback,
    _intake: ReassociationIntake
  ): Promise<ReassociationRejectionResult> {
    this.rejectedReassociations.push(requestId)
    return { requestId, reason: REASSOCIATION_NOT_APPROVED_REASON }
  }

  /** Mock parity — returns a seeded retirement, or `undefined` when none was seeded. */
  async getDeviceRetirement (deviceKey: string, _source?: ReassociationDecisionSource): Promise<DeviceRetirement | undefined> {
    return this.deviceRetirements.get(deviceKey)
  }
}
