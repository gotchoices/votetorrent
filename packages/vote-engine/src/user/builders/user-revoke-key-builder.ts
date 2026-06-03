/**
 * Phase 07 -- BUILD-USER-01 / FOUND-01..03 / FACT-02..04 / VALID-01..03 /
 * SER-01,02,04. Concrete UserRevokeKeyBuilder implementing
 * IUserRevokeKeyBuilder as an additive layer over UserEngine.revokeKey.
 */

import type {
  BuilderError,
  IUserEngine,
  IUserRevokeKeyBuilder,
  MissingField,
  SerializedBuilder
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

interface RevokeKeyDraft {
  key?: string
}

type Draft = Readonly<RevokeKeyDraft>
type DraftValidator = (draft: Draft) => BuilderError[]

const HEX_RE = /^[0-9a-fA-F]+$/

export class UserRevokeKeyBuilder implements IUserRevokeKeyBuilder {
  static readonly KIND = 'user.revokeKey'
  static readonly KIND_VERSION = 1

  private committed = false
  private cachedOutput: void | undefined = undefined

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    UserRevokeKeyBuilder.validateKey
  ]

  constructor (
    private readonly engine: IUserEngine,
    private readonly draft: Draft = {}
  ) {}

  // ---- per-setter validators ----

  private static validateKey (draft: Draft): BuilderError[] {
    if (draft.key === undefined) return []
    if (typeof draft.key !== 'string' || draft.key.length !== 66 || !HEX_RE.test(draft.key)) {
      return [{
        path: 'key',
        code: 'INVALID_KEY_HEX',
        message: 'key must be 66-char hex (compressed secp256k1)',
        kind: 'per-setter'
      }]
    }
    return []
  }

  // ---- private helpers ----

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of UserRevokeKeyBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- IBuilder<string, void> surface ----

  setKey (key: string): this {
    return new UserRevokeKeyBuilder(this.engine, { ...this.draft, key }) as this
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
    return this.draft.key!
  }

  commit (): Promise<void> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(UserRevokeKeyBuilder.KIND)
    }
    this.toEngineInput() // validate before committing
    this.committed = true
    const result = this.engine.revokeKey(this.toEngineInput())
    this.cachedOutput = undefined
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
    if (this.draft.key === undefined) missing.push({ path: 'key', reason: 'required' })
    return Object.freeze(missing)
  }

  update (partial: Partial<string>): this {
    // For string TInput, update with a string directly
    if (typeof partial === 'string') {
      return new UserRevokeKeyBuilder(this.engine, { key: partial }) as this
    }
    return new UserRevokeKeyBuilder(this.engine, { ...this.draft }) as this
  }

  reset (): this {
    return new UserRevokeKeyBuilder(this.engine) as this
  }

  clone (): this {
    return new UserRevokeKeyBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<RevokeKeyDraft> {
    return {
      kind: UserRevokeKeyBuilder.KIND,
      version: UserRevokeKeyBuilder.KIND_VERSION,
      draft: { key: this.draft.key }
    }
  }

  dispose (): void {
    // Reserved no-op per CONTEXT.md
  }

  fromPayload (payload: string): this {
    return new UserRevokeKeyBuilder(this.engine, { key: payload }) as this
  }

  // ---- static methods ----

  static fromJSON (json: SerializedBuilder<unknown>, engine: IUserEngine): UserRevokeKeyBuilder {
    if (json.kind !== UserRevokeKeyBuilder.KIND) {
      throw new Error(
        `UserRevokeKeyBuilder.fromJSON: unknown kind "${json.kind}" (expected "${UserRevokeKeyBuilder.KIND}")`
      )
    }
    if (json.version !== UserRevokeKeyBuilder.KIND_VERSION) {
      throw new Error(
        `UserRevokeKeyBuilder.fromJSON: unsupported version ${json.version} (expected ${UserRevokeKeyBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error('UserRevokeKeyBuilder.fromJSON: draft must be a plain object')
    }
    return new UserRevokeKeyBuilder(engine, draft as RevokeKeyDraft)
  }
}
