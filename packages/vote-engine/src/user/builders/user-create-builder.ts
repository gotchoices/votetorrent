/**
 * Phase 07 -- BUILD-USER-01 / FOUND-01..03 / FACT-02..04 / VALID-01..03 /
 * SER-01,02,04. Concrete UserCreateBuilder implementing IUserCreateBuilder
 * as an additive layer over UserEngine.create.
 */

import type {
  BuilderError,
  CreateUserHistory,
  ImageRef,
  IUserCreateBuilder,
  IUserEngine,
  MissingField,
  SerializedBuilder,
  Signature,
  Timestamp,
  UserKey
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError,
  UserHistoryEvent,
  UserKeyType
} from '@votetorrent/vote-core'

type Draft = Readonly<Partial<CreateUserHistory>>
type DraftValidator = (draft: Draft) => BuilderError[]

const HEX_RE = /^[0-9a-fA-F]+$/

export class UserCreateBuilder implements IUserCreateBuilder {
  static readonly KIND = 'user.create'
  static readonly KIND_VERSION = 1

  private committed = false
  private cachedOutput: void | undefined = undefined

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    UserCreateBuilder.validateEvent,
    UserCreateBuilder.validateTimestamp,
    UserCreateBuilder.validateSignature,
    UserCreateBuilder.validateName,
    UserCreateBuilder.validateImageRef,
    UserCreateBuilder.validateUserKey
  ]

  constructor (
    private readonly engine: IUserEngine,
    private readonly draft: Draft = {}
  ) {}

  // ---- per-setter validators ----

  private static validateEvent (draft: Draft): BuilderError[] {
    if (draft.event === undefined) return []
    if (draft.event !== UserHistoryEvent.create) {
      return [{
        path: 'event',
        code: 'INVALID_EVENT',
        message: 'event must be UserHistoryEvent.create',
        kind: 'per-setter'
      }]
    }
    return []
  }

  private static validateTimestamp (draft: Draft): BuilderError[] {
    if (draft.timestamp === undefined) return []
    if (typeof draft.timestamp !== 'number' || !Number.isFinite(draft.timestamp) || draft.timestamp <= 0) {
      return [{
        path: 'timestamp',
        code: 'INVALID_TIMESTAMP',
        message: 'timestamp must be a finite number > 0',
        kind: 'per-setter'
      }]
    }
    return []
  }

  private static validateSignature (draft: Draft): BuilderError[] {
    if (draft.signature === undefined) return []
    const sig = draft.signature as Signature
    const errors: BuilderError[] = []
    if (typeof sig !== 'object' || sig === null || Array.isArray(sig)) {
      return [{
        path: 'signature',
        code: 'INVALID_SIGNATURE',
        message: 'signature must be an object',
        kind: 'per-setter'
      }]
    }
    if (typeof sig.signature !== 'string' || sig.signature.length !== 128 || !HEX_RE.test(sig.signature)) {
      errors.push({
        path: 'signature.signature',
        code: 'INVALID_SIGNATURE_HEX',
        message: 'signature.signature must be 128-char hex',
        kind: 'per-setter'
      })
    }
    if (typeof sig.signerKey !== 'string' || sig.signerKey.length !== 66 || !HEX_RE.test(sig.signerKey)) {
      errors.push({
        path: 'signature.signerKey',
        code: 'INVALID_SIGNER_KEY',
        message: 'signature.signerKey must be 66-char hex',
        kind: 'per-setter'
      })
    }
    if (typeof sig.signerUserId !== 'string' || sig.signerUserId.trim() === '') {
      errors.push({
        path: 'signature.signerUserId',
        code: 'INVALID_SIGNER_USER_ID',
        message: 'signature.signerUserId must be a non-empty string',
        kind: 'per-setter'
      })
    }
    return errors
  }

  private static validateName (draft: Draft): BuilderError[] {
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

  private static validateImageRef (draft: Draft): BuilderError[] {
    if (draft.imageRef === undefined) return []
    const ref = draft.imageRef as ImageRef | null
    if (
      ref === null ||
      typeof ref !== 'object' ||
      Array.isArray(ref) ||
      typeof (ref as ImageRef).url !== 'string'
    ) {
      return [{
        path: 'imageRef.url',
        code: 'INVALID',
        message: 'imageRef must be an object with a string url field',
        kind: 'per-setter'
      }]
    }
    return []
  }

  private static validateUserKey (draft: Draft): BuilderError[] {
    if (draft.userKey === undefined) return []
    const uk = draft.userKey as UserKey | null
    const errors: BuilderError[] = []
    if (typeof uk !== 'object' || uk === null || Array.isArray(uk)) {
      return [{
        path: 'userKey',
        code: 'INVALID_USER_KEY',
        message: 'userKey must be an object',
        kind: 'per-setter'
      }]
    }
    if (typeof uk.key !== 'string' || uk.key.length !== 66 || !HEX_RE.test(uk.key)) {
      errors.push({
        path: 'userKey.key',
        code: 'INVALID_KEY_HEX',
        message: 'userKey.key must be 66-char hex',
        kind: 'per-setter'
      })
    }
    if (!Object.values(UserKeyType).includes(uk.type)) {
      errors.push({
        path: 'userKey.type',
        code: 'INVALID_KEY_TYPE',
        message: 'userKey.type must be a UserKeyType value',
        kind: 'per-setter'
      })
    }
    if (typeof uk.expiration !== 'number' || !Number.isFinite(uk.expiration) || uk.expiration <= 0) {
      errors.push({
        path: 'userKey.expiration',
        code: 'INVALID_EXPIRATION',
        message: 'userKey.expiration must be a finite number > 0',
        kind: 'per-setter'
      })
    }
    return errors
  }

  // ---- private helpers ----

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of UserCreateBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- IBuilder<CreateUserHistory, void> surface ----

  setEvent (event: typeof UserHistoryEvent.create): this {
    return new UserCreateBuilder(this.engine, { ...this.draft, event }) as this
  }

  setTimestamp (timestamp: Timestamp): this {
    return new UserCreateBuilder(this.engine, { ...this.draft, timestamp }) as this
  }

  setSignature (signature: Signature): this {
    return new UserCreateBuilder(this.engine, { ...this.draft, signature }) as this
  }

  setName (name: string): this {
    return new UserCreateBuilder(this.engine, { ...this.draft, name }) as this
  }

  setImageRef (imageRef: ImageRef): this {
    return new UserCreateBuilder(this.engine, { ...this.draft, imageRef }) as this
  }

  setUserKey (userKey: UserKey): this {
    return new UserCreateBuilder(this.engine, { ...this.draft, userKey }) as this
  }

  build (): CreateUserHistory {
    return this.toEngineInput()
  }

  toEngineInput (): CreateUserHistory {
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
      event: UserHistoryEvent.create,
      timestamp: this.draft.timestamp!,
      signature: this.draft.signature!,
      name: this.draft.name!,
      imageRef: this.draft.imageRef!,
      userKey: this.draft.userKey!
    }
  }

  commit (options?: { inviteSlotCid?: string; inviteSignature?: string }): Promise<void> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(UserCreateBuilder.KIND)
    }
    this.toEngineInput() // validate before committing
    this.committed = true
    const result = this.engine.create(this.toEngineInput(), options)
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
    if (this.draft.event === undefined) missing.push({ path: 'event', reason: 'required' })
    if (this.draft.timestamp === undefined) missing.push({ path: 'timestamp', reason: 'required' })
    if (this.draft.signature === undefined) missing.push({ path: 'signature', reason: 'required' })
    if (this.draft.name === undefined || this.draft.name === null || (typeof this.draft.name === 'string' && this.draft.name.trim() === '')) {
      missing.push({ path: 'name', reason: 'required' })
    }
    if (this.draft.imageRef === undefined) missing.push({ path: 'imageRef', reason: 'required' })
    if (this.draft.userKey === undefined) missing.push({ path: 'userKey', reason: 'required' })
    return Object.freeze(missing)
  }

  update (partial: Partial<CreateUserHistory>): this {
    return new UserCreateBuilder(this.engine, { ...this.draft, ...partial }) as this
  }

  reset (): this {
    return new UserCreateBuilder(this.engine) as this
  }

  clone (): this {
    return new UserCreateBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Partial<CreateUserHistory>> {
    return {
      kind: UserCreateBuilder.KIND,
      version: UserCreateBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {
    // Reserved no-op per CONTEXT.md
  }

  fromPayload (payload: CreateUserHistory): this {
    return new UserCreateBuilder(this.engine, {
      event: payload.event,
      timestamp: payload.timestamp,
      signature: payload.signature,
      name: payload.name,
      imageRef: payload.imageRef,
      userKey: payload.userKey
    }) as this
  }

  // ---- static methods ----

  static fromJSON (json: SerializedBuilder<unknown>, engine: IUserEngine): UserCreateBuilder {
    if (json.kind !== UserCreateBuilder.KIND) {
      throw new Error(
        `UserCreateBuilder.fromJSON: unknown kind "${json.kind}" (expected "${UserCreateBuilder.KIND}")`
      )
    }
    if (json.version !== UserCreateBuilder.KIND_VERSION) {
      throw new Error(
        `UserCreateBuilder.fromJSON: unsupported version ${json.version} (expected ${UserCreateBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error('UserCreateBuilder.fromJSON: draft must be a plain object')
    }
    return new UserCreateBuilder(engine, draft as Partial<CreateUserHistory>)
  }
}
