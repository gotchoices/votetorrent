/**
 * Phase 08 -- BUILD-NET-02 / FACT-02..04 / VALID-01..03 / SER-01..04.
 * Concrete NetworkUnpinAuthorityBuilder implementing
 * INetworkUnpinAuthorityBuilder as an additive layer over
 * NetworkEngine.unpinAuthority.
 *
 * TInput = string (authorityId) -- wrapper draft pattern
 * (mirrors UserRevokeKeyBuilder).
 */

import type {
  BuilderError,
  INetworkEngine,
  INetworkUnpinAuthorityBuilder,
  MissingField,
  SerializedBuilder
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

interface UnpinAuthorityDraft {
  authorityId?: string
}

type Draft = Readonly<UnpinAuthorityDraft>
type DraftValidator = (draft: Draft) => BuilderError[]

export class NetworkUnpinAuthorityBuilder implements INetworkUnpinAuthorityBuilder {
  static readonly KIND = 'network.unpinAuthority'
  static readonly KIND_VERSION = 1

  private committed = false
  private cachedOutput: void | undefined = undefined

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    NetworkUnpinAuthorityBuilder.validateAuthorityId
  ]

  constructor (
    private readonly engine: INetworkEngine,
    private readonly draft: Draft = {}
  ) {}

  // ---- per-setter validators ----

  private static validateAuthorityId (draft: Draft): BuilderError[] {
    if (draft.authorityId === undefined) return []
    if (typeof draft.authorityId !== 'string' || draft.authorityId.trim() === '') {
      return [{
        path: 'authorityId',
        code: 'EMPTY',
        message: 'authorityId must be a non-empty string',
        kind: 'per-setter'
      }]
    }
    return []
  }

  // ---- private helpers ----

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of NetworkUnpinAuthorityBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- IBuilder<string, void> ----

  setAuthorityId (authorityId: string): this {
    return new NetworkUnpinAuthorityBuilder(this.engine, { ...this.draft, authorityId }) as this
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
    return this.draft.authorityId!
  }

  commit (): Promise<void> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(NetworkUnpinAuthorityBuilder.KIND)
    }
    this.toEngineInput() // validate before committing
    this.committed = true
    // FACT-02: delegate verbatim to engine.unpinAuthority(authorityId)
    const result = this.engine.unpinAuthority(this.toEngineInput())
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
    if (this.draft.authorityId === undefined) {
      missing.push({ path: 'authorityId', reason: 'required' })
    }
    return Object.freeze(missing)
  }

  update (partial: Partial<string>): this {
    if (typeof partial === 'string') {
      return new NetworkUnpinAuthorityBuilder(this.engine, { authorityId: partial }) as this
    }
    return new NetworkUnpinAuthorityBuilder(this.engine, { ...this.draft }) as this
  }

  reset (): this {
    return new NetworkUnpinAuthorityBuilder(this.engine) as this
  }

  clone (): this {
    return new NetworkUnpinAuthorityBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<UnpinAuthorityDraft> {
    return {
      kind: NetworkUnpinAuthorityBuilder.KIND,
      version: NetworkUnpinAuthorityBuilder.KIND_VERSION,
      draft: { authorityId: this.draft.authorityId }
    }
  }

  dispose (): void {
    // Reserved no-op per CONTEXT.md
  }

  fromPayload (payload: string): this {
    return new NetworkUnpinAuthorityBuilder(this.engine, { authorityId: payload }) as this
  }

  // ---- static methods ----

  static fromJSON (json: SerializedBuilder<unknown>, engine: INetworkEngine): NetworkUnpinAuthorityBuilder {
    if (json.kind !== NetworkUnpinAuthorityBuilder.KIND) {
      throw new Error(
        `NetworkUnpinAuthorityBuilder.fromJSON: unknown kind "${json.kind}" (expected "${NetworkUnpinAuthorityBuilder.KIND}")`
      )
    }
    if (json.version !== NetworkUnpinAuthorityBuilder.KIND_VERSION) {
      throw new Error(
        `NetworkUnpinAuthorityBuilder.fromJSON: unsupported version ${json.version} (expected ${NetworkUnpinAuthorityBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error(
        'NetworkUnpinAuthorityBuilder.fromJSON: draft must be a plain object'
      )
    }
    return new NetworkUnpinAuthorityBuilder(engine, draft as UnpinAuthorityDraft)
  }
}
