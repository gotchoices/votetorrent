/**
 * Phase 07 -- BUILD-USER-01 / FOUND-01..03 / FACT-02..04 / VALID-01..03 /
 * SER-01,02,04. Concrete UserReviseBuilder implementing IUserReviseBuilder
 * as an additive layer over UserEngine.revise.
 */

import type {
  BuilderError,
  ImageRef,
  IUserEngine,
  IUserReviseBuilder,
  MissingField,
  ReviseUserHistory,
  SerializedBuilder,
  Signature,
  Timestamp,
  UserInfo
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError,
  UserHistoryEvent
} from '@votetorrent/vote-core'

/** Draft tracks the info sub-object as Partial<UserInfo> since setters fill fields individually. */
interface ReviseDraft {
  event?: typeof UserHistoryEvent.revise
  timestamp?: Timestamp
  signature?: Signature
  info?: Partial<UserInfo>
}

type Draft = Readonly<ReviseDraft>
type DraftValidator = (draft: Draft) => BuilderError[]

const HEX_RE = /^[0-9a-fA-F]+$/

export class UserReviseBuilder implements IUserReviseBuilder {
  static readonly KIND = 'user.revise'
  static readonly KIND_VERSION = 1

  private committed = false
  private cachedOutput: void | undefined = undefined

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    UserReviseBuilder.validateEvent,
    UserReviseBuilder.validateTimestamp,
    UserReviseBuilder.validateSignature,
    UserReviseBuilder.validateInfoName,
    UserReviseBuilder.validateInfoImageRef
  ]

  constructor (
    private readonly engine: IUserEngine,
    private readonly draft: Draft = {}
  ) {}

  // ---- per-setter validators ----

  private static validateEvent (draft: Draft): BuilderError[] {
    if (draft.event === undefined) return []
    if ((draft.event as string) !== UserHistoryEvent.revise) {
      return [{
        path: 'event',
        code: 'INVALID_EVENT',
        message: 'event must be UserHistoryEvent.revise',
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

  private static validateInfoName (draft: Draft): BuilderError[] {
    const info = draft.info
    if (info?.name === undefined) return []
    if (typeof info.name !== 'string' || info.name.trim() === '') {
      return [{
        path: 'info.name',
        code: 'EMPTY',
        message: 'info.name required',
        kind: 'per-setter'
      }]
    }
    return []
  }

  private static validateInfoImageRef (draft: Draft): BuilderError[] {
    const info = draft.info
    if (info?.imageRef === undefined) return []
    const ref = info.imageRef as ImageRef | null
    if (
      ref === null ||
      typeof ref !== 'object' ||
      Array.isArray(ref) ||
      typeof (ref as ImageRef).url !== 'string'
    ) {
      return [{
        path: 'info.imageRef.url',
        code: 'INVALID',
        message: 'info.imageRef must be an object with a string url field',
        kind: 'per-setter'
      }]
    }
    return []
  }

  // ---- private helpers ----

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of UserReviseBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- IBuilder<ReviseUserHistory, void> surface ----

  setEvent (event: typeof UserHistoryEvent.revise): this {
    return new UserReviseBuilder(this.engine, { ...this.draft, event }) as this
  }

  setTimestamp (timestamp: Timestamp): this {
    return new UserReviseBuilder(this.engine, { ...this.draft, timestamp }) as this
  }

  setSignature (signature: Signature): this {
    return new UserReviseBuilder(this.engine, { ...this.draft, signature }) as this
  }

  setInfoName (name: string): this {
    const info: Partial<UserInfo> = { ...this.draft.info, name }
    return new UserReviseBuilder(this.engine, { ...this.draft, info }) as this
  }

  setInfoImageRef (imageRef: ImageRef): this {
    const info: Partial<UserInfo> = { ...this.draft.info, imageRef }
    return new UserReviseBuilder(this.engine, { ...this.draft, info }) as this
  }

  build (): ReviseUserHistory {
    return this.toEngineInput()
  }

  toEngineInput (): ReviseUserHistory {
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
      event: UserHistoryEvent.revise,
      timestamp: this.draft.timestamp!,
      signature: this.draft.signature!,
      info: {
        name: this.draft.info!.name!,
        imageRef: this.draft.info!.imageRef!
      }
    }
  }

  commit (): Promise<void> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(UserReviseBuilder.KIND)
    }
    this.toEngineInput() // validate before committing
    this.committed = true
    const result = this.engine.revise(this.toEngineInput())
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
    const info = this.draft.info
    if (info?.name === undefined || (typeof info.name === 'string' && info.name.trim() === '')) {
      missing.push({ path: 'info.name', reason: 'required' })
    }
    if (info?.imageRef === undefined) missing.push({ path: 'info.imageRef', reason: 'required' })
    return Object.freeze(missing)
  }

  update (partial: Partial<ReviseUserHistory>): this {
    const merged: ReviseDraft = { ...this.draft }
    if (partial.event !== undefined) merged.event = partial.event as typeof UserHistoryEvent.revise
    if (partial.timestamp !== undefined) merged.timestamp = partial.timestamp
    if (partial.signature !== undefined) merged.signature = partial.signature
    if (partial.info !== undefined) merged.info = { ...merged.info, ...partial.info }
    return new UserReviseBuilder(this.engine, merged) as this
  }

  reset (): this {
    return new UserReviseBuilder(this.engine) as this
  }

  clone (): this {
    return new UserReviseBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<ReviseDraft> {
    return {
      kind: UserReviseBuilder.KIND,
      version: UserReviseBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {
    // Reserved no-op per CONTEXT.md
  }

  fromPayload (payload: ReviseUserHistory): this {
    return new UserReviseBuilder(this.engine, {
      event: payload.event,
      timestamp: payload.timestamp,
      signature: payload.signature,
      info: { name: payload.info.name, imageRef: payload.info.imageRef }
    }) as this
  }

  // ---- static methods ----

  static fromJSON (json: SerializedBuilder<unknown>, engine: IUserEngine): UserReviseBuilder {
    if (json.kind !== UserReviseBuilder.KIND) {
      throw new Error(
        `UserReviseBuilder.fromJSON: unknown kind "${json.kind}" (expected "${UserReviseBuilder.KIND}")`
      )
    }
    if (json.version !== UserReviseBuilder.KIND_VERSION) {
      throw new Error(
        `UserReviseBuilder.fromJSON: unsupported version ${json.version} (expected ${UserReviseBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error('UserReviseBuilder.fromJSON: draft must be a plain object')
    }
    return new UserReviseBuilder(engine, draft as ReviseDraft)
  }
}
