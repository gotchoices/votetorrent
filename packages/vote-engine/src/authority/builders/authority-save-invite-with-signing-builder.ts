/**
 * Phase 09 -- BUILD-AUTH-01 / VALID-01..03 / SER-01..04 / FACT-02..04.
 * Concrete AuthoritySaveInviteWithSigningBuilder implementing
 * IAuthoritySaveInviteWithSigningBuilder as an additive layer over
 * AuthorityEngine.saveInviteWithSigning.
 */

import type {
  AuthorityInvite,
  BuilderError,
  IAuthorityEngine,
  IAuthoritySaveInviteWithSigningBuilder,
  MissingField,
  OfficerInvite,
  Scope,
  SerializedBuilder,
  Signature
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

type Draft = { invite?: AuthorityInvite | OfficerInvite; scope?: Scope; signature?: Signature }
type DraftValidator = (draft: Readonly<Draft>) => BuilderError[]

export class AuthoritySaveInviteWithSigningBuilder implements IAuthoritySaveInviteWithSigningBuilder {
  static readonly KIND = 'authority.saveInviteWithSigning'
  static readonly KIND_VERSION = 1

  private committed = false
  private cachedOutput: void | undefined = undefined

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    AuthoritySaveInviteWithSigningBuilder.validateInvite,
    AuthoritySaveInviteWithSigningBuilder.validateScope,
    AuthoritySaveInviteWithSigningBuilder.validateSignature
  ]

  constructor (
    private readonly engine: IAuthorityEngine,
    private readonly draft: Readonly<Draft> = {}
  ) {}

  // ---- per-setter validators ----

  private static validateInvite (draft: Readonly<Draft>): BuilderError[] {
    if (draft.invite === undefined || draft.invite === null) return []
    if (
      typeof draft.invite !== 'object' ||
      Array.isArray(draft.invite) ||
      typeof draft.invite.type !== 'string' ||
      typeof draft.invite.expiration !== 'string' ||
      typeof draft.invite.inviteKey !== 'string' ||
      typeof draft.invite.inviteSignature !== 'string'
    ) {
      return [{
        path: 'invite',
        code: 'INVALID',
        message: 'invite must have type, expiration, inviteKey, and inviteSignature',
        kind: 'per-setter'
      }]
    }
    return []
  }

  private static validateScope (draft: Readonly<Draft>): BuilderError[] {
    if (draft.scope === undefined || draft.scope === null) return []
    const validScopes: string[] = ['rn', 'rad', 'vrg', 'iad', 'rnp', 'uai', 'ceb', 'mel', 'cap']
    if (typeof draft.scope !== 'string' || !validScopes.includes(draft.scope)) {
      return [{
        path: 'scope',
        code: 'INVALID',
        message: 'scope must be a valid Scope string',
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

  // ---- private helpers ----

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of AuthoritySaveInviteWithSigningBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- IBuilder<{ invite; scope; signature }, void> surface ----

  setInvite (invite: AuthorityInvite | OfficerInvite): this {
    return new AuthoritySaveInviteWithSigningBuilder(this.engine, { ...this.draft, invite }) as this
  }

  setScope (scope: Scope): this {
    return new AuthoritySaveInviteWithSigningBuilder(this.engine, { ...this.draft, scope }) as this
  }

  setSignature (signature: Signature): this {
    return new AuthoritySaveInviteWithSigningBuilder(this.engine, { ...this.draft, signature }) as this
  }

  build (): { invite: AuthorityInvite | OfficerInvite; scope: Scope; signature: Signature } {
    return this.toEngineInput()
  }

  toEngineInput (): { invite: AuthorityInvite | OfficerInvite; scope: Scope; signature: Signature } {
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
      invite: this.draft.invite!,
      scope: this.draft.scope!,
      signature: this.draft.signature!
    }
  }

  async commit (): Promise<void> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(AuthoritySaveInviteWithSigningBuilder.KIND)
    }
    const input = this.toEngineInput()
    this.committed = true
    await this.engine.saveInviteWithSigning(input.invite, input.scope, input.signature)
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
    if (this.draft.invite === undefined || this.draft.invite === null) {
      missing.push({ path: 'invite', reason: 'required' })
    }
    if (this.draft.scope === undefined || this.draft.scope === null) {
      missing.push({ path: 'scope', reason: 'required' })
    }
    if (this.draft.signature === undefined || this.draft.signature === null) {
      missing.push({ path: 'signature', reason: 'required' })
    }
    return Object.freeze(missing)
  }

  update (partial: Partial<{ invite: AuthorityInvite | OfficerInvite; scope: Scope; signature: Signature }>): this {
    return new AuthoritySaveInviteWithSigningBuilder(this.engine, { ...this.draft, ...partial }) as this
  }

  reset (): this {
    return new AuthoritySaveInviteWithSigningBuilder(this.engine) as this
  }

  clone (): this {
    return new AuthoritySaveInviteWithSigningBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Draft> {
    return {
      kind: AuthoritySaveInviteWithSigningBuilder.KIND,
      version: AuthoritySaveInviteWithSigningBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {
    // Reserved no-op per CONTEXT.md
  }

  fromPayload (payload: { invite: AuthorityInvite | OfficerInvite; scope: Scope; signature: Signature }): this {
    return new AuthoritySaveInviteWithSigningBuilder(this.engine, {
      invite: payload.invite,
      scope: payload.scope,
      signature: payload.signature
    }) as this
  }

  // ---- static methods ----

  static fromJSON (json: SerializedBuilder<unknown>, engine: IAuthorityEngine): AuthoritySaveInviteWithSigningBuilder {
    if (json.kind !== AuthoritySaveInviteWithSigningBuilder.KIND) {
      throw new Error(
        `AuthoritySaveInviteWithSigningBuilder.fromJSON: unknown kind "${json.kind}" (expected "${AuthoritySaveInviteWithSigningBuilder.KIND}")`
      )
    }
    if (json.version !== AuthoritySaveInviteWithSigningBuilder.KIND_VERSION) {
      throw new Error(
        `AuthoritySaveInviteWithSigningBuilder.fromJSON: unsupported version ${json.version} (expected ${AuthoritySaveInviteWithSigningBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error(
        'AuthoritySaveInviteWithSigningBuilder.fromJSON: draft must be a plain object'
      )
    }
    return new AuthoritySaveInviteWithSigningBuilder(engine, draft as Draft)
  }
}
