/**
 * Phase 09 -- BUILD-AUTH-01 / VALID-01..03 / SER-01..04 / FACT-02..04.
 * Concrete AuthorityCreateOfficerInviteBuilder implementing
 * IAuthorityCreateOfficerInviteBuilder as an additive layer over
 * AuthorityEngine.createOfficerInvite.
 */

import type {
  BuilderError,
  IAuthorityEngine,
  IAuthorityCreateOfficerInviteBuilder,
  MissingField,
  OfficerInit,
  OfficerInviteShare,
  Scope,
  SerializedBuilder
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

type DraftValidator = (draft: Readonly<Partial<OfficerInit>>) => BuilderError[]

export class AuthorityCreateOfficerInviteBuilder implements IAuthorityCreateOfficerInviteBuilder {
  static readonly KIND = 'authority.createOfficerInvite'
  static readonly KIND_VERSION = 1

  private committed = false
  private cachedOutput: OfficerInviteShare | undefined = undefined

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    AuthorityCreateOfficerInviteBuilder.validateName,
    AuthorityCreateOfficerInviteBuilder.validateTitle,
    AuthorityCreateOfficerInviteBuilder.validateScopes
  ]

  constructor (
    private readonly engine: IAuthorityEngine,
    private readonly draft: Readonly<Partial<OfficerInit>> = {}
  ) {}

  // ---- per-setter validators ----

  private static validateName (draft: Readonly<Partial<OfficerInit>>): BuilderError[] {
    if (draft.name === undefined || draft.name === null) return []
    if (typeof draft.name !== 'string' || draft.name.trim() === '') {
      return [{
        path: 'name',
        code: 'EMPTY',
        message: 'name required',
        kind: 'per-setter'
      }]
    }
    return []
  }

  private static validateTitle (draft: Readonly<Partial<OfficerInit>>): BuilderError[] {
    if (draft.title === undefined || draft.title === null) return []
    if (typeof draft.title !== 'string' || draft.title.trim() === '') {
      return [{
        path: 'title',
        code: 'EMPTY',
        message: 'title required',
        kind: 'per-setter'
      }]
    }
    return []
  }

  private static validateScopes (draft: Readonly<Partial<OfficerInit>>): BuilderError[] {
    if (draft.scopes === undefined || draft.scopes === null) return []
    if (!Array.isArray(draft.scopes) || draft.scopes.length === 0) {
      return [{
        path: 'scopes',
        code: 'EMPTY',
        message: 'at least one scope required',
        kind: 'per-setter'
      }]
    }
    return []
  }

  // ---- private helpers ----

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of AuthorityCreateOfficerInviteBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- IBuilder<OfficerInit, OfficerInviteShare> surface ----

  setName (name: string): this {
    return new AuthorityCreateOfficerInviteBuilder(this.engine, { ...this.draft, name }) as this
  }

  setTitle (title: string): this {
    return new AuthorityCreateOfficerInviteBuilder(this.engine, { ...this.draft, title }) as this
  }

  setScopes (scopes: Scope[]): this {
    return new AuthorityCreateOfficerInviteBuilder(this.engine, { ...this.draft, scopes }) as this
  }

  build (): OfficerInit {
    return this.toEngineInput()
  }

  toEngineInput (): OfficerInit {
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
      name: this.draft.name!,
      title: this.draft.title!,
      scopes: this.draft.scopes!
    }
  }

  commit (): Promise<OfficerInviteShare> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(AuthorityCreateOfficerInviteBuilder.KIND)
    }
    const input = this.toEngineInput()
    this.committed = true
    const result = this.engine.createOfficerInvite(input)
    this.cachedOutput = result
    return Promise.resolve(result)
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
    if (this.draft.name === undefined || this.draft.name === null) {
      missing.push({ path: 'name', reason: 'required' })
    }
    if (this.draft.title === undefined || this.draft.title === null) {
      missing.push({ path: 'title', reason: 'required' })
    }
    if (this.draft.scopes === undefined || this.draft.scopes === null) {
      missing.push({ path: 'scopes', reason: 'required' })
    }
    return Object.freeze(missing)
  }

  update (partial: Partial<OfficerInit>): this {
    return new AuthorityCreateOfficerInviteBuilder(this.engine, { ...this.draft, ...partial }) as this
  }

  reset (): this {
    return new AuthorityCreateOfficerInviteBuilder(this.engine) as this
  }

  clone (): this {
    return new AuthorityCreateOfficerInviteBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Partial<OfficerInit>> {
    return {
      kind: AuthorityCreateOfficerInviteBuilder.KIND,
      version: AuthorityCreateOfficerInviteBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {
    // Reserved no-op per CONTEXT.md
  }

  fromPayload (payload: OfficerInit): this {
    return new AuthorityCreateOfficerInviteBuilder(this.engine, {
      name: payload.name,
      title: payload.title,
      scopes: payload.scopes
    }) as this
  }

  // ---- static methods ----

  static fromJSON (json: SerializedBuilder<unknown>, engine: IAuthorityEngine): AuthorityCreateOfficerInviteBuilder {
    if (json.kind !== AuthorityCreateOfficerInviteBuilder.KIND) {
      throw new Error(
        `AuthorityCreateOfficerInviteBuilder.fromJSON: unknown kind "${json.kind}" (expected "${AuthorityCreateOfficerInviteBuilder.KIND}")`
      )
    }
    if (json.version !== AuthorityCreateOfficerInviteBuilder.KIND_VERSION) {
      throw new Error(
        `AuthorityCreateOfficerInviteBuilder.fromJSON: unsupported version ${json.version} (expected ${AuthorityCreateOfficerInviteBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error(
        'AuthorityCreateOfficerInviteBuilder.fromJSON: draft must be a plain object'
      )
    }
    return new AuthorityCreateOfficerInviteBuilder(engine, draft as Partial<OfficerInit>)
  }
}
