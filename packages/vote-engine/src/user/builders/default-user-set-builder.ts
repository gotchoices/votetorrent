/**
 * Phase 07 -- BUILD-USER-02 / FOUND-01..03 / FACT-02..04 / VALID-01..03 /
 * SER-01,02,04. Concrete DefaultUserSetBuilder implementing
 * IDefaultUserSetBuilder as an additive layer over DefaultUserEngine.set.
 */

import type {
  BuilderError,
  DefaultUser,
  IDefaultUserEngine,
  IDefaultUserSetBuilder,
  ImageRef,
  MissingField,
  SerializedBuilder
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

type DraftValidator = (draft: Readonly<Partial<DefaultUser>>) => BuilderError[]

export class DefaultUserSetBuilder implements IDefaultUserSetBuilder {
  static readonly KIND = 'defaultUser.set'
  static readonly KIND_VERSION = 1

  private committed = false
  private cachedOutput: void | undefined = undefined

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    DefaultUserSetBuilder.validateName,
    DefaultUserSetBuilder.validateImageRef,
    DefaultUserSetBuilder.validateCrossField
  ]

  constructor (
    private readonly engine: IDefaultUserEngine,
    private readonly draft: Readonly<Partial<DefaultUser>> = {}
  ) {}

  // ---- per-setter validators ----

  private static validateName (draft: Readonly<Partial<DefaultUser>>): BuilderError[] {
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

  private static validateImageRef (draft: Readonly<Partial<DefaultUser>>): BuilderError[] {
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

  private static validateCrossField (_draft: Readonly<Partial<DefaultUser>>): BuilderError[] {
    // No cross-field constraints for DefaultUser (2 independent fields).
    // Wiring present to prove the pattern for downstream builders.
    return []
  }

  // ---- private helpers ----

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of DefaultUserSetBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- IBuilder<DefaultUser, void> surface ----

  setName (name: string): this {
    return new DefaultUserSetBuilder(this.engine, { ...this.draft, name }) as this
  }

  setImageRef (imageRef: ImageRef | undefined): this {
    return new DefaultUserSetBuilder(this.engine, { ...this.draft, imageRef }) as this
  }

  build (): DefaultUser {
    return this.toEngineInput()
  }

  toEngineInput (): DefaultUser {
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
      imageRef: this.draft.imageRef
    }
  }

  commit (): Promise<void> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(DefaultUserSetBuilder.KIND)
    }
    this.toEngineInput() // validate before committing
    this.committed = true
    const result = this.engine.set(this.toEngineInput())
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
    if (this.draft.name === undefined || this.draft.name === null || (typeof this.draft.name === 'string' && this.draft.name.trim() === '')) {
      missing.push({ path: 'name', reason: 'required' })
    }
    return Object.freeze(missing)
  }

  update (partial: Partial<DefaultUser>): this {
    return new DefaultUserSetBuilder(this.engine, { ...this.draft, ...partial }) as this
  }

  reset (): this {
    return new DefaultUserSetBuilder(this.engine) as this
  }

  clone (): this {
    return new DefaultUserSetBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Partial<DefaultUser>> {
    return {
      kind: DefaultUserSetBuilder.KIND,
      version: DefaultUserSetBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {
    // Reserved no-op per CONTEXT.md
  }

  fromPayload (payload: DefaultUser): this {
    return new DefaultUserSetBuilder(this.engine, {
      name: payload.name,
      imageRef: payload.imageRef
    }) as this
  }

  // ---- static methods ----

  static fromJSON (json: SerializedBuilder<unknown>, engine: IDefaultUserEngine): DefaultUserSetBuilder {
    if (json.kind !== DefaultUserSetBuilder.KIND) {
      throw new Error(
        `DefaultUserSetBuilder.fromJSON: unknown kind "${json.kind}" (expected "${DefaultUserSetBuilder.KIND}")`
      )
    }
    if (json.version !== DefaultUserSetBuilder.KIND_VERSION) {
      throw new Error(
        `DefaultUserSetBuilder.fromJSON: unsupported version ${json.version} (expected ${DefaultUserSetBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error(
        'DefaultUserSetBuilder.fromJSON: draft must be a plain object'
      )
    }
    return new DefaultUserSetBuilder(engine, draft as Partial<DefaultUser>)
  }
}
