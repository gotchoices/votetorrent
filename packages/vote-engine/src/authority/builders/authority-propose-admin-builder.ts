/**
 * Phase 09 -- BUILD-AUTH-01 / VALID-01..03 / SER-01..04 / FACT-02..04.
 * Concrete AuthorityProposeAdminBuilder implementing
 * IAuthorityProposeAdminBuilder as an additive layer over
 * AuthorityEngine.proposeAdmin.
 */

import type {
  AdminInit,
  BuilderError,
  IAuthorityEngine,
  IAuthorityProposeAdminBuilder,
  MissingField,
  Proposal,
  SerializedBuilder,
  Signature
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

type Draft = { admin?: Proposal<AdminInit>; signature?: Signature }
type DraftValidator = (draft: Readonly<Draft>) => BuilderError[]

export class AuthorityProposeAdminBuilder implements IAuthorityProposeAdminBuilder {
  static readonly KIND = 'authority.proposeAdmin'
  static readonly KIND_VERSION = 1

  private committed = false
  private cachedOutput: void | undefined = undefined

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    AuthorityProposeAdminBuilder.validateAdmin,
    AuthorityProposeAdminBuilder.validateSignature,
    AuthorityProposeAdminBuilder.validateCrossField
  ]

  constructor (
    private readonly engine: IAuthorityEngine,
    private readonly draft: Readonly<Draft> = {}
  ) {}

  // ---- per-setter validators ----

  private static validateAdmin (draft: Readonly<Draft>): BuilderError[] {
    if (draft.admin === undefined || draft.admin === null) return []
    if (
      typeof draft.admin !== 'object' ||
      Array.isArray(draft.admin) ||
      !('proposed' in draft.admin) ||
      !('signers' in draft.admin) ||
      !Array.isArray(draft.admin.signers)
    ) {
      return [{
        path: 'admin',
        code: 'INVALID',
        message: 'admin must be a Proposal<AdminInit> with proposed and signers',
        kind: 'per-setter'
      }]
    }
    return []
  }

  private static validateSignature (draft: Readonly<Draft>): BuilderError[] {
    if (draft.signature === undefined || draft.signature === null) return []
    if (
      typeof draft.signature !== 'object' ||
      Array.isArray(draft.signature) ||
      typeof draft.signature.signature !== 'string' || draft.signature.signature.trim() === '' ||
      typeof draft.signature.signerKey !== 'string' || draft.signature.signerKey.trim() === '' ||
      typeof draft.signature.signerUserId !== 'string' || draft.signature.signerUserId.trim() === ''
    ) {
      return [{
        path: 'signature',
        code: 'INVALID',
        message: 'signature must have non-empty signature, signerKey, and signerUserId',
        kind: 'per-setter'
      }]
    }
    return []
  }

  private static validateCrossField (draft: Readonly<Draft>): BuilderError[] {
    if (draft.admin === undefined || draft.admin === null) return []
    if (
      typeof draft.admin === 'object' &&
      !Array.isArray(draft.admin) &&
      'signers' in draft.admin &&
      Array.isArray(draft.admin.signers) &&
      draft.admin.signers.length === 0
    ) {
      return [{
        path: 'admin.signers',
        code: 'NO_SIGNERS',
        message: 'admin.signers must be non-empty',
        kind: 'cross-field'
      }]
    }
    return []
  }

  // ---- private helpers ----

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of AuthorityProposeAdminBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- IBuilder<{ admin; signature }, void> surface ----

  setAdmin (admin: Proposal<AdminInit>): this {
    return new AuthorityProposeAdminBuilder(this.engine, { ...this.draft, admin }) as this
  }

  setSignature (signature: Signature): this {
    return new AuthorityProposeAdminBuilder(this.engine, { ...this.draft, signature }) as this
  }

  build (): { admin: Proposal<AdminInit>; signature: Signature } {
    return this.toEngineInput()
  }

  toEngineInput (): { admin: Proposal<AdminInit>; signature: Signature } {
    const errors = this.runValidators()
    const missing = this.missingFields()
    if (errors.length > 0 || missing.length > 0) {
      const allErrors: BuilderError[] = [...errors]
      for (const m of missing) {
        allErrors.push({
          path: m.path,
          code: 'MISSING',
          message: m.reason,
          kind: 'per-setter'
        })
      }
      throw new BuilderValidationError(allErrors)
    }
    return {
      admin: this.draft.admin!,
      signature: this.draft.signature!
    }
  }

  async commit (): Promise<void> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(AuthorityProposeAdminBuilder.KIND)
    }
    const input = this.toEngineInput()
    this.committed = true
    await this.engine.proposeAdmin(input.admin, input.signature)
    this.cachedOutput = undefined
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

  missingFields (): readonly MissingField[] {
    const missing: MissingField[] = []
    if (this.draft.admin === undefined || this.draft.admin === null) {
      missing.push({ path: 'admin', reason: 'required' })
    }
    if (this.draft.signature === undefined || this.draft.signature === null) {
      missing.push({ path: 'signature', reason: 'required' })
    }
    return Object.freeze(missing)
  }

  update (partial: Partial<{ admin: Proposal<AdminInit>; signature: Signature }>): this {
    return new AuthorityProposeAdminBuilder(this.engine, { ...this.draft, ...partial }) as this
  }

  reset (): this {
    return new AuthorityProposeAdminBuilder(this.engine) as this
  }

  clone (): this {
    return new AuthorityProposeAdminBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Draft> {
    return {
      kind: AuthorityProposeAdminBuilder.KIND,
      version: AuthorityProposeAdminBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {
    // Reserved no-op per CONTEXT.md
  }

  fromPayload (payload: { admin: Proposal<AdminInit>; signature: Signature }): this {
    return new AuthorityProposeAdminBuilder(this.engine, {
      admin: payload.admin,
      signature: payload.signature
    }) as this
  }

  // ---- static methods ----

  static fromJSON (json: SerializedBuilder<unknown>, engine: IAuthorityEngine): AuthorityProposeAdminBuilder {
    if (json.kind !== AuthorityProposeAdminBuilder.KIND) {
      throw new Error(
        `AuthorityProposeAdminBuilder.fromJSON: unknown kind "${json.kind}" (expected "${AuthorityProposeAdminBuilder.KIND}")`
      )
    }
    if (json.version !== AuthorityProposeAdminBuilder.KIND_VERSION) {
      throw new Error(
        `AuthorityProposeAdminBuilder.fromJSON: unsupported version ${json.version} (expected ${AuthorityProposeAdminBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error(
        'AuthorityProposeAdminBuilder.fromJSON: draft must be a plain object'
      )
    }
    return new AuthorityProposeAdminBuilder(engine, draft as Draft)
  }
}
