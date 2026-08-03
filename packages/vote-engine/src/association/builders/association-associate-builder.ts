/**
 * Phase 42-04 (D-02) — Concrete AssociationAssociateBuilder implementing
 * IAssociationAssociateBuilder as an additive layer over
 * IAssociationEngine.associate. Mirrors AuthorityProposeAdminBuilder's /
 * RegistrationRegisterBuilder's Draft/VALIDATORS/runValidators/
 * missingFields/toEngineInput/commit/toJSON/fromJSON/static-fromJSON
 * skeleton verbatim.
 *
 * Note: like IRegistrationRegisterBuilder (and unlike
 * IAuthorityProposeAdminBuilder), IAssociationAssociateBuilder extends
 * `IBuilder<AssociateInit, void>` — TInput is `AssociateInit` ALONE, no
 * signature field. The signing material therefore lives on the internal
 * Draft only (not part of toEngineInput()'s returned shape); commit() reads
 * it off the Draft directly before delegating to engine.associate(input, sig).
 */

import type {
  AssociateInit,
  BuilderError,
  DeviceAttestation,
  IAssociationAssociateBuilder,
  IAssociationEngine,
  MissingField,
  SerializedBuilder,
  Signature
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

type Draft = {
  registrantId?: string
  deviceKey?: string
  deviceHash?: string
  nonce?: string
  attestation?: DeviceAttestation
  signatureOrCallback?: SignatureOrCallback
}
type DraftValidator = (draft: Readonly<Draft>) => BuilderError[]

export class AssociationAssociateBuilder implements IAssociationAssociateBuilder {
  static readonly KIND = 'association.associate'
  static readonly KIND_VERSION = 1

  private committed = false

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    AssociationAssociateBuilder.validateRegistrantId,
    AssociationAssociateBuilder.validateDeviceKey,
    AssociationAssociateBuilder.validateNonce,
    AssociationAssociateBuilder.validateAttestation,
    AssociationAssociateBuilder.validateSignatureOrCallback,
    AssociationAssociateBuilder.validateNonceCrossField
  ]

  constructor (
    private readonly engine: IAssociationEngine,
    private readonly draft: Readonly<Draft> = {}
  ) {}

  // ---- per-setter validators ----

  private static validateRegistrantId (draft: Readonly<Draft>): BuilderError[] {
    if (draft.registrantId === undefined || draft.registrantId === null) return []
    if (typeof draft.registrantId !== 'string' || draft.registrantId.trim() === '') {
      return [{ path: 'registrantId', code: 'INVALID', message: 'registrantId must be a non-empty string', kind: 'per-setter' }]
    }
    return []
  }

  private static validateDeviceKey (draft: Readonly<Draft>): BuilderError[] {
    if (draft.deviceKey === undefined || draft.deviceKey === null) return []
    if (typeof draft.deviceKey !== 'string' || draft.deviceKey.trim() === '') {
      return [{ path: 'deviceKey', code: 'INVALID', message: 'deviceKey must be a non-empty string', kind: 'per-setter' }]
    }
    return []
  }

  private static validateNonce (draft: Readonly<Draft>): BuilderError[] {
    if (draft.nonce === undefined || draft.nonce === null) return []
    if (typeof draft.nonce !== 'string' || draft.nonce.trim() === '') {
      return [{ path: 'nonce', code: 'INVALID', message: 'nonce must be a non-empty string', kind: 'per-setter' }]
    }
    return []
  }

  private static validateAttestation (draft: Readonly<Draft>): BuilderError[] {
    if (draft.attestation === undefined || draft.attestation === null) return []
    const a = draft.attestation
    if (
      typeof a !== 'object' || Array.isArray(a) ||
      typeof a.publicKey !== 'string' || a.publicKey.trim() === '' ||
      typeof a.deviceId !== 'string' || a.deviceId.trim() === '' ||
      typeof a.attestationTime !== 'number' ||
      !Array.isArray(a.certificateChain)
    ) {
      return [{
        path: 'attestation',
        code: 'INVALID',
        message: 'attestation must have non-empty publicKey/deviceId, a numeric attestationTime, and a certificateChain array',
        kind: 'per-setter'
      }]
    }
    return []
  }

  private static validateSignatureOrCallback (draft: Readonly<Draft>): BuilderError[] {
    if (draft.signatureOrCallback === undefined || draft.signatureOrCallback === null) return []
    if (typeof draft.signatureOrCallback === 'function') return []
    const sig = draft.signatureOrCallback
    if (
      typeof sig !== 'object' || Array.isArray(sig) ||
      typeof sig.signature !== 'string' || sig.signature.trim() === '' ||
      typeof sig.signerKey !== 'string' || sig.signerKey.trim() === '' ||
      typeof sig.signerUserId !== 'string' || sig.signerUserId.trim() === ''
    ) {
      return [{
        path: 'signatureOrCallback',
        code: 'INVALID',
        message: 'signatureOrCallback must be a function or a Signature with non-empty signature/signerKey/signerUserId',
        kind: 'per-setter'
      }]
    }
    return []
  }

  /**
   * Cross-field: when the attestation carries an explicit platform-level
   * nonce (`AndroidAttestationDetails.nonce` — the only platform detail this
   * phase's model exposes a nonce on; `IOSAttestationDetails` has none), it
   * must equal the draft's own `nonce` (the challenge nonce being answered).
   */
  private static validateNonceCrossField (draft: Readonly<Draft>): BuilderError[] {
    if (draft.attestation === undefined || draft.attestation === null || draft.nonce === undefined || draft.nonce === null) return []
    const platformDetails = draft.attestation.platformDetails
    if (platformDetails?.type === 'Android' && platformDetails.nonce !== draft.nonce) {
      return [{
        path: 'attestation.platformDetails.nonce',
        code: 'NONCE_MISMATCH',
        message: 'attestation.platformDetails.nonce must equal the challenge nonce being answered',
        kind: 'cross-field'
      }]
    }
    return []
  }

  // ---- private helpers ----

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of AssociationAssociateBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- setters (additive convenience — not part of IAssociationAssociateBuilder) ----

  setRegistrantId (registrantId: string): this {
    return new AssociationAssociateBuilder(this.engine, { ...this.draft, registrantId }) as this
  }

  setDeviceKey (deviceKey: string): this {
    return new AssociationAssociateBuilder(this.engine, { ...this.draft, deviceKey }) as this
  }

  setDeviceHash (deviceHash: string | undefined): this {
    return new AssociationAssociateBuilder(this.engine, { ...this.draft, deviceHash }) as this
  }

  setNonce (nonce: string): this {
    return new AssociationAssociateBuilder(this.engine, { ...this.draft, nonce }) as this
  }

  setAttestation (attestation: DeviceAttestation): this {
    return new AssociationAssociateBuilder(this.engine, { ...this.draft, attestation }) as this
  }

  setSignatureOrCallback (signatureOrCallback: SignatureOrCallback): this {
    return new AssociationAssociateBuilder(this.engine, { ...this.draft, signatureOrCallback }) as this
  }

  // ---- IBuilder<AssociateInit, void> surface ----

  build (): AssociateInit {
    return this.toEngineInput()
  }

  /**
   * Validates + returns ONLY the `AssociateInit`-shaped fields (registrantId/
   * deviceKey/deviceHash/nonce/attestation) — `signatureOrCallback` lives
   * outside this return shape (IAssociationAssociateBuilder's TInput is
   * `AssociateInit` alone) and is validated separately by `commit()`.
   */
  toEngineInput (): AssociateInit {
    const errors = this.runValidators()
    const missing = this.missingFieldsForInput()
    if (errors.length > 0 || missing.length > 0) {
      const allErrors: BuilderError[] = [...errors]
      for (const m of missing) {
        allErrors.push({ path: m.path, code: 'MISSING', message: m.reason, kind: 'per-setter' })
      }
      throw new BuilderValidationError(allErrors)
    }
    return {
      registrantId: this.draft.registrantId!,
      deviceKey: this.draft.deviceKey!,
      deviceHash: this.draft.deviceHash,
      nonce: this.draft.nonce!,
      attestation: this.draft.attestation!
    }
  }

  async commit (): Promise<void> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(AssociationAssociateBuilder.KIND)
    }
    const input = this.toEngineInput()
    if (this.draft.signatureOrCallback === undefined || this.draft.signatureOrCallback === null) {
      throw new BuilderValidationError([
        { path: 'signatureOrCallback', code: 'MISSING', message: 'required', kind: 'per-setter' }
      ])
    }
    const signatureOrCallback = this.draft.signatureOrCallback
    this.committed = true
    await this.engine.associate(input, signatureOrCallback)
  }

  isValid (): boolean {
    const errors = this.runValidators()
    const missing = this.missingFields()
    return errors.length === 0 && missing.length === 0
  }

  errors (): readonly BuilderError[] {
    const validatorErrors = this.runValidators()
    const missing = this.missingFields()
    if (missing.length === 0) return validatorErrors
    const all: BuilderError[] = [...validatorErrors]
    for (const m of missing) {
      all.push({ path: m.path, code: 'MISSING', message: m.reason, kind: 'per-setter' })
    }
    return Object.freeze(all)
  }

  /** registrantId + deviceKey + nonce + attestation only — exactly what toEngineInput() needs. */
  private missingFieldsForInput (): MissingField[] {
    const missing: MissingField[] = []
    if (this.draft.registrantId === undefined || this.draft.registrantId === null) {
      missing.push({ path: 'registrantId', reason: 'required' })
    }
    if (this.draft.deviceKey === undefined || this.draft.deviceKey === null) {
      missing.push({ path: 'deviceKey', reason: 'required' })
    }
    if (this.draft.nonce === undefined || this.draft.nonce === null) {
      missing.push({ path: 'nonce', reason: 'required' })
    }
    if (this.draft.attestation === undefined || this.draft.attestation === null) {
      missing.push({ path: 'attestation', reason: 'required' })
    }
    return missing
  }

  /** Full commit-readiness surface — used by the public isValid()/errors()/missingFields() IBuilder surface. */
  missingFields (): readonly MissingField[] {
    const missing = this.missingFieldsForInput()
    if (this.draft.signatureOrCallback === undefined || this.draft.signatureOrCallback === null) {
      missing.push({ path: 'signatureOrCallback', reason: 'required' })
    }
    return Object.freeze(missing)
  }

  update (partial: Partial<AssociateInit>): this {
    return new AssociationAssociateBuilder(this.engine, { ...this.draft, ...partial }) as this
  }

  reset (): this {
    return new AssociationAssociateBuilder(this.engine) as this
  }

  clone (): this {
    return new AssociationAssociateBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Draft> {
    return {
      kind: AssociationAssociateBuilder.KIND,
      version: AssociationAssociateBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {
    // Reserved no-op per CONTEXT.md
  }

  fromPayload (payload: AssociateInit): this {
    return new AssociationAssociateBuilder(this.engine, {
      ...this.draft,
      registrantId: payload.registrantId,
      deviceKey: payload.deviceKey,
      deviceHash: payload.deviceHash,
      nonce: payload.nonce,
      attestation: payload.attestation
    }) as this
  }

  // ---- static methods ----

  static fromJSON (json: SerializedBuilder<unknown>, engine: IAssociationEngine): AssociationAssociateBuilder {
    if (json.kind !== AssociationAssociateBuilder.KIND) {
      throw new Error(
        `AssociationAssociateBuilder.fromJSON: unknown kind "${json.kind}" (expected "${AssociationAssociateBuilder.KIND}")`
      )
    }
    if (json.version !== AssociationAssociateBuilder.KIND_VERSION) {
      throw new Error(
        `AssociationAssociateBuilder.fromJSON: unsupported version ${json.version} (expected ${AssociationAssociateBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error('AssociationAssociateBuilder.fromJSON: draft must be a plain object')
    }
    return new AssociationAssociateBuilder(engine, draft as Draft)
  }
}
