/**
 * Phase 07 -- BUILD-USER-01 / FOUND-01..03 / FACT-02..04 / VALID-01..03 /
 * SER-01,02,04. Concrete UserAddKeyBuilder implementing IUserAddKeyBuilder
 * as an additive layer over UserEngine.addKey.
 */

import type {
  BuilderError,
  IUserAddKeyBuilder,
  IUserEngine,
  MissingField,
  SerializedBuilder,
  Timestamp,
  UserKey
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError,
  UserKeyType
} from '@votetorrent/vote-core'

type Draft = Readonly<Partial<UserKey>>
type DraftValidator = (draft: Draft) => BuilderError[]

const HEX_RE = /^[0-9a-fA-F]+$/

export class UserAddKeyBuilder implements IUserAddKeyBuilder {
  static readonly KIND = 'user.addKey'
  static readonly KIND_VERSION = 1

  private committed = false
  private cachedOutput: void | undefined = undefined

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    UserAddKeyBuilder.validateKey,
    UserAddKeyBuilder.validateType,
    UserAddKeyBuilder.validateExpirationFormat,
    UserAddKeyBuilder.validateExpirationFuture
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

  private static validateType (draft: Draft): BuilderError[] {
    if (draft.type === undefined) return []
    if (!Object.values(UserKeyType).includes(draft.type)) {
      return [{
        path: 'type',
        code: 'INVALID_KEY_TYPE',
        message: 'type must be a UserKeyType value (M or Y)',
        kind: 'per-setter'
      }]
    }
    return []
  }

  private static validateExpirationFormat (draft: Draft): BuilderError[] {
    if (draft.expiration === undefined) return []
    if (typeof draft.expiration !== 'number' || !Number.isFinite(draft.expiration) || draft.expiration <= 0) {
      return [{
        path: 'expiration',
        code: 'INVALID_EXPIRATION',
        message: 'expiration must be a finite number > 0',
        kind: 'per-setter'
      }]
    }
    return []
  }

  private static validateExpirationFuture (draft: Draft): BuilderError[] {
    if (draft.expiration === undefined) return []
    if (typeof draft.expiration !== 'number' || !Number.isFinite(draft.expiration)) return []
    if (draft.expiration <= Date.now()) {
      return [{
        path: 'expiration',
        code: 'EXPIRED',
        message: 'expiration must be in the future',
        kind: 'cross-field'
      }]
    }
    return []
  }

  // ---- private helpers ----

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of UserAddKeyBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- IBuilder<UserKey, void> surface ----

  setKey (key: string): this {
    return new UserAddKeyBuilder(this.engine, { ...this.draft, key }) as this
  }

  setType (type: typeof UserKeyType.mobile | typeof UserKeyType.yubico): this {
    return new UserAddKeyBuilder(this.engine, { ...this.draft, type }) as this
  }

  setExpiration (expiration: Timestamp): this {
    return new UserAddKeyBuilder(this.engine, { ...this.draft, expiration }) as this
  }

  build (): UserKey {
    return this.toEngineInput()
  }

  toEngineInput (): UserKey {
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
      key: this.draft.key!,
      type: this.draft.type!,
      expiration: this.draft.expiration!
    }
  }

  commit (): Promise<void> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(UserAddKeyBuilder.KIND)
    }
    this.toEngineInput() // validate before committing
    this.committed = true
    const result = this.engine.addKey(this.toEngineInput())
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
    if (this.draft.type === undefined) missing.push({ path: 'type', reason: 'required' })
    if (this.draft.expiration === undefined) missing.push({ path: 'expiration', reason: 'required' })
    return Object.freeze(missing)
  }

  update (partial: Partial<UserKey>): this {
    return new UserAddKeyBuilder(this.engine, { ...this.draft, ...partial }) as this
  }

  reset (): this {
    return new UserAddKeyBuilder(this.engine) as this
  }

  clone (): this {
    return new UserAddKeyBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Partial<UserKey>> {
    return {
      kind: UserAddKeyBuilder.KIND,
      version: UserAddKeyBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {
    // Reserved no-op per CONTEXT.md
  }

  fromPayload (payload: UserKey): this {
    return new UserAddKeyBuilder(this.engine, {
      key: payload.key,
      type: payload.type,
      expiration: payload.expiration
    }) as this
  }

  // ---- static methods ----

  static fromJSON (json: SerializedBuilder<unknown>, engine: IUserEngine): UserAddKeyBuilder {
    if (json.kind !== UserAddKeyBuilder.KIND) {
      throw new Error(
        `UserAddKeyBuilder.fromJSON: unknown kind "${json.kind}" (expected "${UserAddKeyBuilder.KIND}")`
      )
    }
    if (json.version !== UserAddKeyBuilder.KIND_VERSION) {
      throw new Error(
        `UserAddKeyBuilder.fromJSON: unsupported version ${json.version} (expected ${UserAddKeyBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error('UserAddKeyBuilder.fromJSON: draft must be a plain object')
    }
    return new UserAddKeyBuilder(engine, draft as Partial<UserKey>)
  }
}
