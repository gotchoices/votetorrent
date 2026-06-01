/**
 * Phase 09 -- BUILD-SIGN-01 / VALID-01..03 / SER-01..04 / FACT-02..04.
 * Concrete SigningSignBuilder implementing ISigningSignBuilder as an
 * additive layer over SigningEngine.sign.
 *
 * SECURITY: This builder holds NO private-key material, NO cryptographic
 * nonces, and NO @noble/curves or @noble/hashes imports. The draft's
 * `nonce` field is the AdminSigning session UUID (public), not a
 * secp256k1 nonce. The `signature` field holds only the public output
 * (hex-encoded signature + signer public key + signer user ID).
 */

import type {
  BuilderError,
  ISigningEngine,
  ISigningSignBuilder,
  MissingField,
  SerializedBuilder,
  Signature
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

type Draft = { nonce?: string; signature?: Signature }
type DraftValidator = (draft: Readonly<Draft>) => BuilderError[]

export class SigningSignBuilder implements ISigningSignBuilder {
  static readonly KIND = 'signing.sign'
  static readonly KIND_VERSION = 1

  private committed = false
  private cachedOutput: boolean | undefined = undefined

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    SigningSignBuilder.validateNonce,
    SigningSignBuilder.validateSignature
  ]

  constructor (
    private readonly engine: ISigningEngine,
    private readonly draft: Readonly<Draft> = {}
  ) {}

  // ---- per-setter validators ----

  private static validateNonce (draft: Readonly<Draft>): BuilderError[] {
    if (draft.nonce === undefined || draft.nonce === null) return []
    if (typeof draft.nonce !== 'string' || draft.nonce.trim() === '') {
      return [{
        path: 'nonce',
        code: 'EMPTY',
        message: 'nonce required',
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
    for (const validator of SigningSignBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- IBuilder<{ nonce; signature }, boolean> surface ----

  /**
   * Set the AdminSigning session UUID.
   *
   * NOTE: This is the AdminSigning session identifier (a UUID), NOT a
   * cryptographic secp256k1 nonce. It is safe to persist and display.
   */
  setNonce (nonce: string): this {
    return new SigningSignBuilder(this.engine, { ...this.draft, nonce }) as this
  }

  setSignature (signature: Signature): this {
    return new SigningSignBuilder(this.engine, { ...this.draft, signature }) as this
  }

  build (): { nonce: string; signature: Signature } {
    return this.toEngineInput()
  }

  toEngineInput (): { nonce: string; signature: Signature } {
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
      nonce: this.draft.nonce!,
      signature: this.draft.signature!
    }
  }

  async commit (): Promise<boolean> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(SigningSignBuilder.KIND)
    }
    const input = this.toEngineInput()
    this.committed = true
    const result = await this.engine.sign(input.nonce, input.signature)
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
    if (this.draft.nonce === undefined || this.draft.nonce === null) {
      missing.push({ path: 'nonce', reason: 'required' })
    }
    if (this.draft.signature === undefined || this.draft.signature === null) {
      missing.push({ path: 'signature', reason: 'required' })
    }
    return Object.freeze(missing)
  }

  update (partial: Partial<{ nonce: string; signature: Signature }>): this {
    return new SigningSignBuilder(this.engine, { ...this.draft, ...partial }) as this
  }

  reset (): this {
    return new SigningSignBuilder(this.engine) as this
  }

  clone (): this {
    return new SigningSignBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Draft> {
    return {
      kind: SigningSignBuilder.KIND,
      version: SigningSignBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {
    // Reserved no-op per CONTEXT.md
  }

  fromPayload (payload: { nonce: string; signature: Signature }): this {
    return new SigningSignBuilder(this.engine, {
      nonce: payload.nonce,
      signature: payload.signature
    }) as this
  }

  // ---- static methods ----

  static fromJSON (json: SerializedBuilder<unknown>, engine: ISigningEngine): SigningSignBuilder {
    if (json.kind !== SigningSignBuilder.KIND) {
      throw new Error(
        `SigningSignBuilder.fromJSON: unknown kind "${json.kind}" (expected "${SigningSignBuilder.KIND}")`
      )
    }
    if (json.version !== SigningSignBuilder.KIND_VERSION) {
      throw new Error(
        `SigningSignBuilder.fromJSON: unsupported version ${json.version} (expected ${SigningSignBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error(
        'SigningSignBuilder.fromJSON: draft must be a plain object'
      )
    }
    return new SigningSignBuilder(engine, draft as Draft)
  }
}
