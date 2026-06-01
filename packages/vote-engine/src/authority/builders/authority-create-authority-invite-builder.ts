/**
 * Phase 09 -- BUILD-AUTH-01 / VALID-01..03 / SER-01..04 / FACT-02..04.
 * Concrete AuthorityCreateAuthorityInviteBuilder implementing
 * IAuthorityCreateAuthorityInviteBuilder as an additive layer over
 * AuthorityEngine.createAuthorityInvite.
 */

import type {
  BuilderError,
  IAuthorityEngine,
  IAuthorityCreateAuthorityInviteBuilder,
  MissingField,
  AuthorityInviteShare,
  SerializedBuilder
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

type Draft = { name?: string }
type DraftValidator = (draft: Readonly<Draft>) => BuilderError[]

export class AuthorityCreateAuthorityInviteBuilder implements IAuthorityCreateAuthorityInviteBuilder {
  static readonly KIND = 'authority.createAuthorityInvite'
  static readonly KIND_VERSION = 1

  private committed = false
  private cachedOutput: AuthorityInviteShare | undefined = undefined

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    AuthorityCreateAuthorityInviteBuilder.validateName
  ]

  constructor (
    private readonly engine: IAuthorityEngine,
    private readonly draft: Readonly<Draft> = {}
  ) {}

  // ---- per-setter validators ----

  private static validateName (draft: Readonly<Draft>): BuilderError[] {
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

  // ---- private helpers ----

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of AuthorityCreateAuthorityInviteBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- IBuilder<string, AuthorityInviteShare> surface ----

  setName (name: string): this {
    return new AuthorityCreateAuthorityInviteBuilder(this.engine, { ...this.draft, name }) as this
  }

  build (): string {
    return this.toEngineInput()
  }

  toEngineInput (): string {
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
    return this.draft.name!
  }

  commit (): Promise<AuthorityInviteShare> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(AuthorityCreateAuthorityInviteBuilder.KIND)
    }
    const input = this.toEngineInput()
    this.committed = true
    const result = this.engine.createAuthorityInvite(input)
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
    return Object.freeze(missing)
  }

  update (partial: Partial<string>): this {
    // For string TInput, update is equivalent to setName when a string is provided
    return this as this
  }

  reset (): this {
    return new AuthorityCreateAuthorityInviteBuilder(this.engine) as this
  }

  clone (): this {
    return new AuthorityCreateAuthorityInviteBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Draft> {
    return {
      kind: AuthorityCreateAuthorityInviteBuilder.KIND,
      version: AuthorityCreateAuthorityInviteBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {
    // Reserved no-op per CONTEXT.md
  }

  fromPayload (payload: string): this {
    return new AuthorityCreateAuthorityInviteBuilder(this.engine, {
      name: payload
    }) as this
  }

  // ---- static methods ----

  static fromJSON (json: SerializedBuilder<unknown>, engine: IAuthorityEngine): AuthorityCreateAuthorityInviteBuilder {
    if (json.kind !== AuthorityCreateAuthorityInviteBuilder.KIND) {
      throw new Error(
        `AuthorityCreateAuthorityInviteBuilder.fromJSON: unknown kind "${json.kind}" (expected "${AuthorityCreateAuthorityInviteBuilder.KIND}")`
      )
    }
    if (json.version !== AuthorityCreateAuthorityInviteBuilder.KIND_VERSION) {
      throw new Error(
        `AuthorityCreateAuthorityInviteBuilder.fromJSON: unsupported version ${json.version} (expected ${AuthorityCreateAuthorityInviteBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error(
        'AuthorityCreateAuthorityInviteBuilder.fromJSON: draft must be a plain object'
      )
    }
    return new AuthorityCreateAuthorityInviteBuilder(engine, draft as Draft)
  }
}
