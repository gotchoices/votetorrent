/**
 * Phase 09 -- BUILD-SIGN-01 / VALID-01..03 / SER-01..04 / FACT-02..04.
 * Concrete SigningStartSigningSessionBuilder implementing
 * ISigningStartSigningSessionBuilder as an additive layer over
 * SigningEngine.startSigningSession.
 *
 * Phase 12 -- D-10: Updated to use digestArgs: AdminDigestArgs | null
 * instead of digest: string to match the new SQL-side digest migration interface.
 *
 * SECURITY: This builder holds NO private-key material, NO cryptographic
 * nonces, and NO @noble/curves or @noble/hashes imports. All draft fields
 * are public-facing metadata: authorityId (UUID), digestArgs (typed fields for SQL),
 * scope (privilege enum), signature (hex-encoded public output).
 */

import type {
  AdminDigestArgs,
  BuilderError,
  ISigningEngine,
  ISigningStartSigningSessionBuilder,
  MissingField,
  Scope,
  SerializedBuilder,
  Signature,
  SigningResult
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

/** Valid Scope values for compile-time-safe runtime validation. */
const VALID_SCOPES: readonly string[] = ['rn', 'rad', 'vrg', 'iad', 'rnp', 'uai', 'ceb', 'mel', 'cap']

type Draft = { authorityId?: string; digestArgs?: AdminDigestArgs | null; scope?: Scope; signature?: Signature; nonce?: string }
type DraftValidator = (draft: Readonly<Draft>) => BuilderError[]

export class SigningStartSigningSessionBuilder implements ISigningStartSigningSessionBuilder {
  static readonly KIND = 'signing.startSigningSession'
  static readonly KIND_VERSION = 2

  private committed = false
  private cachedOutput: SigningResult | undefined = undefined

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    SigningStartSigningSessionBuilder.validateAuthorityId,
    SigningStartSigningSessionBuilder.validateDigestArgs,
    SigningStartSigningSessionBuilder.validateScope,
    SigningStartSigningSessionBuilder.validateSignature
  ]

  constructor (
    private readonly engine: ISigningEngine,
    private readonly draft: Readonly<Draft> = {}
  ) {}

  // ---- per-setter validators ----

  private static validateAuthorityId (draft: Readonly<Draft>): BuilderError[] {
    if (draft.authorityId === undefined || draft.authorityId === null) return []
    if (typeof draft.authorityId !== 'string' || draft.authorityId.trim() === '') {
      return [{
        path: 'authorityId',
        code: 'EMPTY',
        message: 'authorityId required',
        kind: 'per-setter'
      }]
    }
    return []
  }

  private static validateDigestArgs (draft: Readonly<Draft>): BuilderError[] {
    // digestArgs may be explicitly set to null (invite flow) — that is valid
    if (draft.digestArgs === undefined) return []
    if (draft.digestArgs === null) return []
    // When set to an object, validate it has the required AdminDigestArgs fields
    if (typeof draft.digestArgs !== 'object' || Array.isArray(draft.digestArgs)) {
      return [{
        path: 'digestArgs',
        code: 'INVALID',
        message: 'digestArgs must be AdminDigestArgs or null',
        kind: 'per-setter'
      }]
    }
    const errors: BuilderError[] = []
    if (typeof draft.digestArgs.authorityId !== 'string' || draft.digestArgs.authorityId.trim() === '') {
      errors.push({ path: 'digestArgs.authorityId', code: 'EMPTY', message: 'digestArgs.authorityId required', kind: 'per-setter' })
    }
    if (typeof draft.digestArgs.effectiveAt !== 'string' || draft.digestArgs.effectiveAt.trim() === '') {
      errors.push({ path: 'digestArgs.effectiveAt', code: 'EMPTY', message: 'digestArgs.effectiveAt required', kind: 'per-setter' })
    }
    if (typeof draft.digestArgs.thresholdPolicies !== 'string' || draft.digestArgs.thresholdPolicies.trim() === '') {
      errors.push({ path: 'digestArgs.thresholdPolicies', code: 'EMPTY', message: 'digestArgs.thresholdPolicies required', kind: 'per-setter' })
    }
    return errors
  }

  private static validateScope (draft: Readonly<Draft>): BuilderError[] {
    if (draft.scope === undefined || draft.scope === null) return []
    if (!VALID_SCOPES.includes(draft.scope)) {
      return [{
        path: 'scope',
        code: 'INVALID_SCOPE',
        message: `scope must be one of: ${VALID_SCOPES.join(', ')}`,
        kind: 'per-setter'
      }]
    }
    return []
  }

  private static validateSignature (draft: Readonly<Draft>): BuilderError[] {
    if (draft.signature === undefined || draft.signature === null) return []
    const errors: BuilderError[] = []
    if (typeof draft.signature !== 'object' || Array.isArray(draft.signature)) {
      return [{
        path: 'signature',
        code: 'INVALID',
        message: 'signature must be a Signature object',
        kind: 'per-setter'
      }]
    }
    if (typeof draft.signature.signature !== 'string' || draft.signature.signature.trim() === '') {
      errors.push({
        path: 'signature.signature',
        code: 'EMPTY',
        message: 'signature.signature required',
        kind: 'per-setter'
      })
    }
    if (typeof draft.signature.signerKey !== 'string' || draft.signature.signerKey.trim() === '') {
      errors.push({
        path: 'signature.signerKey',
        code: 'EMPTY',
        message: 'signature.signerKey required',
        kind: 'per-setter'
      })
    }
    if (typeof draft.signature.signerUserId !== 'string' || draft.signature.signerUserId.trim() === '') {
      errors.push({
        path: 'signature.signerUserId',
        code: 'EMPTY',
        message: 'signature.signerUserId required',
        kind: 'per-setter'
      })
    }
    return errors
  }

  // ---- private helpers ----

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of SigningStartSigningSessionBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- IBuilder<{ authorityId; digestArgs; scope; signature; nonce? }, SigningResult> surface ----

  setAuthorityId (authorityId: string): this {
    return new SigningStartSigningSessionBuilder(this.engine, { ...this.draft, authorityId }) as this
  }

  setDigestArgs (digestArgs: AdminDigestArgs | null): this {
    return new SigningStartSigningSessionBuilder(this.engine, { ...this.draft, digestArgs }) as this
  }

  setScope (scope: Scope): this {
    return new SigningStartSigningSessionBuilder(this.engine, { ...this.draft, scope }) as this
  }

  setSignature (signature: Signature): this {
    return new SigningStartSigningSessionBuilder(this.engine, { ...this.draft, signature }) as this
  }

  setNonce (nonce: string): this {
    return new SigningStartSigningSessionBuilder(this.engine, { ...this.draft, nonce }) as this
  }

  build (): { authorityId: string; digestArgs: AdminDigestArgs | null; scope: Scope; signature: Signature; nonce?: string } {
    return this.toEngineInput()
  }

  toEngineInput (): { authorityId: string; digestArgs: AdminDigestArgs | null; scope: Scope; signature: Signature; nonce?: string } {
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
      authorityId: this.draft.authorityId!,
      digestArgs: this.draft.digestArgs!,
      scope: this.draft.scope!,
      signature: this.draft.signature!,
      nonce: this.draft.nonce
    }
  }

  async commit (): Promise<SigningResult> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(SigningStartSigningSessionBuilder.KIND)
    }
    const input = this.toEngineInput()
    this.committed = true
    const result = await this.engine.startSigningSession(
      input.authorityId,
      input.digestArgs,
      input.scope,
      input.signature,
      input.nonce
    )
    this.cachedOutput = result
    return result
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
    if (this.draft.authorityId === undefined || this.draft.authorityId === null) {
      missing.push({ path: 'authorityId', reason: 'required' })
    }
    // digestArgs can be null (invite flow) — only missing if undefined
    if (this.draft.digestArgs === undefined) {
      missing.push({ path: 'digestArgs', reason: 'required (pass null for invite flow)' })
    }
    if (this.draft.scope === undefined || this.draft.scope === null) {
      missing.push({ path: 'scope', reason: 'required' })
    }
    if (this.draft.signature === undefined || this.draft.signature === null) {
      missing.push({ path: 'signature', reason: 'required' })
    }
    return Object.freeze(missing)
  }

  update (partial: Partial<{ authorityId: string; digestArgs: AdminDigestArgs | null; scope: Scope; signature: Signature; nonce?: string }>): this {
    return new SigningStartSigningSessionBuilder(this.engine, { ...this.draft, ...partial }) as this
  }

  reset (): this {
    return new SigningStartSigningSessionBuilder(this.engine) as this
  }

  clone (): this {
    return new SigningStartSigningSessionBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Draft> {
    return {
      kind: SigningStartSigningSessionBuilder.KIND,
      version: SigningStartSigningSessionBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {
    // Reserved no-op per CONTEXT.md
  }

  fromPayload (payload: { authorityId: string; digestArgs: AdminDigestArgs | null; scope: Scope; signature: Signature; nonce?: string }): this {
    return new SigningStartSigningSessionBuilder(this.engine, {
      authorityId: payload.authorityId,
      digestArgs: payload.digestArgs,
      scope: payload.scope,
      signature: payload.signature,
      nonce: payload.nonce
    }) as this
  }

  // ---- static methods ----

  static fromJSON (json: SerializedBuilder<unknown>, engine: ISigningEngine): SigningStartSigningSessionBuilder {
    if (json.kind !== SigningStartSigningSessionBuilder.KIND) {
      throw new Error(
        `SigningStartSigningSessionBuilder.fromJSON: unknown kind "${json.kind}" (expected "${SigningStartSigningSessionBuilder.KIND}")`
      )
    }
    if (json.version !== SigningStartSigningSessionBuilder.KIND_VERSION) {
      throw new Error(
        `SigningStartSigningSessionBuilder.fromJSON: unsupported version ${json.version} (expected ${SigningStartSigningSessionBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error(
        'SigningStartSigningSessionBuilder.fromJSON: draft must be a plain object'
      )
    }
    return new SigningStartSigningSessionBuilder(engine, draft as Draft)
  }
}
