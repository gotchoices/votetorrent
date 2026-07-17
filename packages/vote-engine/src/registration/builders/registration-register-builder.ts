/**
 * Phase 42-03 (D-02) — Concrete RegistrationRegisterBuilder implementing
 * IRegistrationRegisterBuilder as an additive layer over
 * IRegistrationEngine.register. Mirrors AuthorityProposeAdminBuilder's
 * Draft/VALIDATORS/runValidators/missingFields/toEngineInput/commit/toJSON/
 * fromJSON/static-fromJSON skeleton verbatim.
 *
 * Note: unlike IAuthorityProposeAdminBuilder (whose IBuilder<TInput,void>
 * bundles `{ admin, signature }` into TInput), IRegistrationRegisterBuilder
 * extends `IBuilder<RegisterInit, void>` — TInput is RegisterInit ALONE, no
 * signature field. The signing material therefore lives on the internal
 * Draft only (not part of toEngineInput()'s returned shape); commit() reads
 * it off the Draft directly before delegating to engine.register(input, sig).
 */

import type {
  BuilderError,
  IRegistrationEngine,
  IRegistrationRegisterBuilder,
  MissingField,
  RegisterInit,
  SerializedBuilder,
  Signature
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

type Draft = {
  electionId?: RegisterInit['electionId']
  registrant?: RegisterInit['registrant']
  public?: RegisterInit['public']
  private?: RegisterInit['private']
  selective?: RegisterInit['selective']
  signatureOrCallback?: SignatureOrCallback
}
type DraftValidator = (draft: Readonly<Draft>) => BuilderError[]

export class RegistrationRegisterBuilder implements IRegistrationRegisterBuilder {
  static readonly KIND = 'registration.register'
  static readonly KIND_VERSION = 1

  private committed = false

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    RegistrationRegisterBuilder.validateElectionId,
    RegistrationRegisterBuilder.validateRegistrant,
    RegistrationRegisterBuilder.validatePrivate,
    RegistrationRegisterBuilder.validateSignatureOrCallback
  ]

  constructor (
    private readonly engine: IRegistrationEngine,
    private readonly draft: Readonly<Draft> = {}
  ) {}

  // ---- per-setter validators ----

  /**
   * D-10 (42-07): `electionId` is OPTIONAL on the Draft (a submission with
   * no election context has no field policy to enforce against — see
   * `field-policy.ts`'s `validateFieldPolicy`) — this validator only checks
   * well-formedness WHEN present (non-empty string), mirroring
   * `validateRegistrant`'s "absent is fine, malformed is not" shape.
   */
  private static validateElectionId (draft: Readonly<Draft>): BuilderError[] {
    if (draft.electionId === undefined || draft.electionId === null) return []
    if (typeof draft.electionId !== 'string' || draft.electionId.trim() === '') {
      return [{
        path: 'electionId',
        code: 'INVALID',
        message: 'electionId must be a non-empty string when present',
        kind: 'per-setter'
      }]
    }
    return []
  }

  private static validateRegistrant (draft: Readonly<Draft>): BuilderError[] {
    if (draft.registrant === undefined || draft.registrant === null) return []
    const r = draft.registrant
    if (
      typeof r !== 'object' || Array.isArray(r) ||
      typeof r.id !== 'string' || r.id.trim() === '' ||
      typeof r.authorityId !== 'string' || r.authorityId.trim() === '' ||
      r.expiration === undefined || r.expiration === null
    ) {
      return [{
        path: 'registrant',
        code: 'INVALID',
        message: 'registrant must have non-empty id, authorityId, and an expiration',
        kind: 'per-setter'
      }]
    }
    return []
  }

  private static validatePrivate (draft: Readonly<Draft>): BuilderError[] {
    if (draft.private === undefined || draft.private === null) return []
    const p = draft.private
    if (
      typeof p !== 'object' || Array.isArray(p) ||
      p.expiration === undefined || p.expiration === null ||
      !Array.isArray(p.details)
    ) {
      return [{
        path: 'private',
        code: 'INVALID',
        message: 'private must have an expiration and a details array',
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

  // ---- private helpers ----

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of RegistrationRegisterBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- setters (additive convenience — not part of IRegistrationRegisterBuilder) ----

  /** D-10 (42-07): scope the submission to an election's ElectionRegistrationField policy. Optional. */
  setElectionId (electionId: RegisterInit['electionId']): this {
    return new RegistrationRegisterBuilder(this.engine, { ...this.draft, electionId }) as this
  }

  setRegistrant (registrant: RegisterInit['registrant']): this {
    return new RegistrationRegisterBuilder(this.engine, { ...this.draft, registrant }) as this
  }

  setPublic (publicPayload: RegisterInit['public']): this {
    return new RegistrationRegisterBuilder(this.engine, { ...this.draft, public: publicPayload }) as this
  }

  setPrivate (privatePayload: RegisterInit['private']): this {
    return new RegistrationRegisterBuilder(this.engine, { ...this.draft, private: privatePayload }) as this
  }

  setSelective (selectivePayload: RegisterInit['selective']): this {
    return new RegistrationRegisterBuilder(this.engine, { ...this.draft, selective: selectivePayload }) as this
  }

  setSignatureOrCallback (signatureOrCallback: SignatureOrCallback): this {
    return new RegistrationRegisterBuilder(this.engine, { ...this.draft, signatureOrCallback }) as this
  }

  // ---- IBuilder<RegisterInit, void> surface ----

  build (): RegisterInit {
    return this.toEngineInput()
  }

  /**
   * Validates + returns ONLY the `RegisterInit`-shaped fields (registrant/
   * public/private/selective) — `signatureOrCallback` lives outside this
   * return shape (IRegistrationRegisterBuilder's TInput is `RegisterInit`
   * alone, per the interface) and is validated separately by `commit()`.
   * This lets a caller build/serialize/inspect a draft's engine-input shape
   * before a signer is wired up (e.g. an RN form reviewing entered fields
   * ahead of the biometric-signing step).
   */
  toEngineInput (): RegisterInit {
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
      electionId: this.draft.electionId,
      registrant: this.draft.registrant!,
      public: this.draft.public,
      private: this.draft.private!,
      selective: this.draft.selective
    }
  }

  async commit (): Promise<void> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(RegistrationRegisterBuilder.KIND)
    }
    const input = this.toEngineInput()
    if (this.draft.signatureOrCallback === undefined || this.draft.signatureOrCallback === null) {
      throw new BuilderValidationError([
        { path: 'signatureOrCallback', code: 'MISSING', message: 'required', kind: 'per-setter' }
      ])
    }
    const signatureOrCallback = this.draft.signatureOrCallback
    this.committed = true
    await this.engine.register(input, signatureOrCallback)
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

  /** registrant + private only — exactly what toEngineInput() needs to return RegisterInit. */
  private missingFieldsForInput (): MissingField[] {
    const missing: MissingField[] = []
    if (this.draft.registrant === undefined || this.draft.registrant === null) {
      missing.push({ path: 'registrant', reason: 'required' })
    }
    if (this.draft.private === undefined || this.draft.private === null) {
      missing.push({ path: 'private', reason: 'required' })
    }
    return missing
  }

  /** Full commit-readiness surface (registrant + private + signatureOrCallback) — used by
   * the public isValid()/errors()/missingFields() IBuilder surface (RN form "ready to submit"). */
  missingFields (): readonly MissingField[] {
    const missing = this.missingFieldsForInput()
    if (this.draft.signatureOrCallback === undefined || this.draft.signatureOrCallback === null) {
      missing.push({ path: 'signatureOrCallback', reason: 'required' })
    }
    return Object.freeze(missing)
  }

  update (partial: Partial<RegisterInit>): this {
    return new RegistrationRegisterBuilder(this.engine, { ...this.draft, ...partial }) as this
  }

  reset (): this {
    return new RegistrationRegisterBuilder(this.engine) as this
  }

  clone (): this {
    return new RegistrationRegisterBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Draft> {
    return {
      kind: RegistrationRegisterBuilder.KIND,
      version: RegistrationRegisterBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {
    // Reserved no-op per CONTEXT.md
  }

  fromPayload (payload: RegisterInit): this {
    return new RegistrationRegisterBuilder(this.engine, {
      ...this.draft,
      electionId: payload.electionId,
      registrant: payload.registrant,
      public: payload.public,
      private: payload.private,
      selective: payload.selective
    }) as this
  }

  // ---- static methods ----

  static fromJSON (json: SerializedBuilder<unknown>, engine: IRegistrationEngine): RegistrationRegisterBuilder {
    if (json.kind !== RegistrationRegisterBuilder.KIND) {
      throw new Error(
        `RegistrationRegisterBuilder.fromJSON: unknown kind "${json.kind}" (expected "${RegistrationRegisterBuilder.KIND}")`
      )
    }
    if (json.version !== RegistrationRegisterBuilder.KIND_VERSION) {
      throw new Error(
        `RegistrationRegisterBuilder.fromJSON: unsupported version ${json.version} (expected ${RegistrationRegisterBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error('RegistrationRegisterBuilder.fromJSON: draft must be a plain object')
    }
    return new RegistrationRegisterBuilder(engine, draft as Draft)
  }
}
