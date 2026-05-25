/**
 * Phase 08 -- BUILD-NET-02 / FACT-02..04 / VALID-01..03 / SER-01..04.
 * Concrete NetworkPinAuthorityBuilder implementing
 * INetworkPinAuthorityBuilder as an additive layer over
 * NetworkEngine.pinAuthority.
 */

import type {
  Authority,
  BuilderError,
  INetworkEngine,
  INetworkPinAuthorityBuilder,
  MissingField,
  SerializedBuilder
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

type Draft = Readonly<Partial<Authority>>
type DraftValidator = (draft: Draft) => BuilderError[]

export class NetworkPinAuthorityBuilder implements INetworkPinAuthorityBuilder {
  static readonly KIND = 'network.pinAuthority'
  static readonly KIND_VERSION = 1

  private committed = false
  private cachedOutput: void | undefined = undefined

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    NetworkPinAuthorityBuilder.validateAuthority
  ]

  constructor (
    private readonly engine: INetworkEngine,
    private readonly draft: Draft = {}
  ) {}

  // ---- per-setter validators ----

  private static validateAuthority (draft: Draft): BuilderError[] {
    const errors: BuilderError[] = []

    if (draft.id !== undefined && (typeof draft.id !== 'string' || draft.id.trim() === '')) {
      errors.push({
        path: 'id',
        code: 'EMPTY',
        message: 'id must be a non-empty string',
        kind: 'per-setter'
      })
    }

    if (draft.name !== undefined && (typeof draft.name !== 'string' || draft.name.trim() === '')) {
      errors.push({
        path: 'name',
        code: 'EMPTY',
        message: 'name must be a non-empty string',
        kind: 'per-setter'
      })
    }

    if (draft.domainName !== undefined && (typeof draft.domainName !== 'string' || draft.domainName.trim() === '')) {
      errors.push({
        path: 'domainName',
        code: 'EMPTY',
        message: 'domainName must be a non-empty string',
        kind: 'per-setter'
      })
    }

    return errors
  }

  // ---- private helpers ----

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of NetworkPinAuthorityBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- IBuilder<Authority, void> ----

  setAuthority (authority: Authority): this {
    return new NetworkPinAuthorityBuilder(this.engine, { ...authority }) as this
  }

  build (): Authority {
    return this.toEngineInput()
  }

  toEngineInput (): Authority {
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
      id: this.draft.id!,
      name: this.draft.name!,
      domainName: this.draft.domainName!,
      imageRef: this.draft.imageRef
    }
  }

  commit (): Promise<void> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(NetworkPinAuthorityBuilder.KIND)
    }
    const input = this.toEngineInput()
    this.committed = true
    // FACT-02: delegate verbatim to engine.pinAuthority(authority)
    const result = this.engine.pinAuthority(input)
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
    if (this.draft.id === undefined || this.draft.id === null) {
      missing.push({ path: 'id', reason: 'required' })
    }
    if (this.draft.name === undefined || this.draft.name === null) {
      missing.push({ path: 'name', reason: 'required' })
    }
    if (this.draft.domainName === undefined || this.draft.domainName === null) {
      missing.push({ path: 'domainName', reason: 'required' })
    }
    return Object.freeze(missing)
  }

  update (partial: Partial<Authority>): this {
    return new NetworkPinAuthorityBuilder(this.engine, { ...this.draft, ...partial }) as this
  }

  reset (): this {
    return new NetworkPinAuthorityBuilder(this.engine) as this
  }

  clone (): this {
    return new NetworkPinAuthorityBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Partial<Authority>> {
    return {
      kind: NetworkPinAuthorityBuilder.KIND,
      version: NetworkPinAuthorityBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {
    // Reserved no-op per CONTEXT.md
  }

  fromPayload (payload: Authority): this {
    return new NetworkPinAuthorityBuilder(this.engine, {
      id: payload.id,
      name: payload.name,
      domainName: payload.domainName,
      imageRef: payload.imageRef
    }) as this
  }

  // ---- static methods ----

  static fromJSON (json: SerializedBuilder<unknown>, engine: INetworkEngine): NetworkPinAuthorityBuilder {
    if (json.kind !== NetworkPinAuthorityBuilder.KIND) {
      throw new Error(
        `NetworkPinAuthorityBuilder.fromJSON: unknown kind "${json.kind}" (expected "${NetworkPinAuthorityBuilder.KIND}")`
      )
    }
    if (json.version !== NetworkPinAuthorityBuilder.KIND_VERSION) {
      throw new Error(
        `NetworkPinAuthorityBuilder.fromJSON: unsupported version ${json.version} (expected ${NetworkPinAuthorityBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error(
        'NetworkPinAuthorityBuilder.fromJSON: draft must be a plain object'
      )
    }
    return new NetworkPinAuthorityBuilder(engine, draft as Partial<Authority>)
  }
}
