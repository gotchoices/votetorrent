/**
 * Phase 08 -- BUILD-NET-01 / FACT-02..04 / VALID-01..03 / SER-01..04.
 * Concrete NetworksCreateBuilder implementing INetworksCreateBuilder
 * as an additive layer over NetworksEngine.create.
 *
 * TInput = { networkInit: NetworkInit; user: User } (compound payload).
 * TOutput = INetworkEngine (constructed engine instance -- NOT serialized
 * in toJSON(); reconstructed at commit time per ROADMAP).
 */

import type {
  BuilderError,
  INetworkEngine,
  INetworksCreateBuilder,
  INetworksEngine,
  MissingField,
  NetworkInit,
  SerializedBuilder,
  User
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

type Draft = Readonly<Partial<{ networkInit: NetworkInit; user: User }>>
type DraftValidator = (draft: Draft) => BuilderError[]

export class NetworksCreateBuilder implements INetworksCreateBuilder {
  static readonly KIND = 'networks.create'
  static readonly KIND_VERSION = 1

  private committed = false
  private cachedOutput: INetworkEngine | undefined = undefined

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    NetworksCreateBuilder.validateNetworkInit,
    NetworksCreateBuilder.validateUser,
    NetworksCreateBuilder.validateCrossField
  ]

  constructor (
    private readonly engine: INetworksEngine,
    private readonly draft: Draft = {}
  ) {}

  // ---- per-setter validators ----

  private static validateNetworkInit (draft: Draft): BuilderError[] {
    const ni = draft.networkInit
    if (ni === undefined || ni === null) return []
    const errors: BuilderError[] = []

    if (typeof ni !== 'object' || Array.isArray(ni)) {
      errors.push({
        path: 'networkInit',
        code: 'INVALID',
        message: 'networkInit must be a plain object',
        kind: 'per-setter'
      })
      return errors
    }

    if (typeof ni.name !== 'string' || ni.name.trim() === '') {
      errors.push({
        path: 'networkInit.name',
        code: 'EMPTY',
        message: 'networkInit.name must be a non-empty string',
        kind: 'per-setter'
      })
    }

    if (ni.policies === undefined || ni.policies === null || typeof ni.policies !== 'object' || Array.isArray(ni.policies)) {
      errors.push({
        path: 'networkInit.policies',
        code: 'INVALID',
        message: 'networkInit.policies must be a valid object',
        kind: 'per-setter'
      })
    }

    if (ni.primaryAuthority === undefined || ni.primaryAuthority === null || typeof ni.primaryAuthority !== 'object') {
      errors.push({
        path: 'networkInit.primaryAuthority',
        code: 'INVALID',
        message: 'networkInit.primaryAuthority must be a valid object',
        kind: 'per-setter'
      })
    }

    if (ni.admin === undefined || ni.admin === null || typeof ni.admin !== 'object') {
      errors.push({
        path: 'networkInit.admin',
        code: 'INVALID',
        message: 'networkInit.admin must be a valid object',
        kind: 'per-setter'
      })
    }

    if (!Array.isArray(ni.relays)) {
      errors.push({
        path: 'networkInit.relays',
        code: 'INVALID',
        message: 'networkInit.relays must be an array',
        kind: 'per-setter'
      })
    }

    return errors
  }

  private static validateUser (draft: Draft): BuilderError[] {
    const u = draft.user
    if (u === undefined || u === null) return []
    const errors: BuilderError[] = []

    if (typeof u !== 'object' || Array.isArray(u)) {
      errors.push({
        path: 'user',
        code: 'INVALID',
        message: 'user must be a plain object',
        kind: 'per-setter'
      })
      return errors
    }

    if (typeof u.id !== 'string' || u.id.trim() === '') {
      errors.push({
        path: 'user.id',
        code: 'EMPTY',
        message: 'user.id must be a non-empty string',
        kind: 'per-setter'
      })
    }

    if (typeof u.name !== 'string') {
      errors.push({
        path: 'user.name',
        code: 'INVALID',
        message: 'user.name must be a string',
        kind: 'per-setter'
      })
    }

    return errors
  }

  private static validateCrossField (draft: Draft): BuilderError[] {
    const ni = draft.networkInit
    const u = draft.user
    if (ni === undefined || u === undefined) return []

    const errors: BuilderError[] = []

    // TSA count mismatch
    if (
      ni.policies &&
      typeof ni.policies.numberRequiredTSAs === 'number' &&
      Array.isArray(ni.policies.timestampAuthorities) &&
      ni.policies.numberRequiredTSAs > ni.policies.timestampAuthorities.length
    ) {
      errors.push({
        path: 'networkInit.policies.numberRequiredTSAs',
        code: 'TSA_MISMATCH',
        message: `numberRequiredTSAs (${ni.policies.numberRequiredTSAs}) exceeds timestampAuthorities count (${ni.policies.timestampAuthorities.length})`,
        kind: 'cross-field'
      })
    }

    // Relays must be non-empty when both fields present
    if (Array.isArray(ni.relays) && ni.relays.length === 0) {
      errors.push({
        path: 'networkInit.relays',
        code: 'NO_RELAYS',
        message: 'networkInit.relays must not be empty',
        kind: 'cross-field'
      })
    }

    return errors
  }

  // ---- private helpers ----

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of NetworksCreateBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- IBuilder<{ networkInit: NetworkInit; user: User }, INetworkEngine> ----

  setNetworkInit (networkInit: NetworkInit): this {
    return new NetworksCreateBuilder(this.engine, { ...this.draft, networkInit }) as this
  }

  setUser (user: User): this {
    return new NetworksCreateBuilder(this.engine, { ...this.draft, user }) as this
  }

  build (): { networkInit: NetworkInit; user: User } {
    return this.toEngineInput()
  }

  toEngineInput (): { networkInit: NetworkInit; user: User } {
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
      networkInit: this.draft.networkInit!,
      user: this.draft.user!
    }
  }

  commit (): Promise<INetworkEngine> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(NetworksCreateBuilder.KIND)
    }
    const input = this.toEngineInput()
    this.committed = true
    // FACT-02: delegate verbatim to engine.create(networkInit, user)
    const promise = this.engine.create(input.networkInit, input.user)
    return promise.then((result) => {
      this.cachedOutput = result
      return result
    })
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
    if (this.draft.networkInit === undefined || this.draft.networkInit === null) {
      missing.push({ path: 'networkInit', reason: 'required' })
    }
    if (this.draft.user === undefined || this.draft.user === null) {
      missing.push({ path: 'user', reason: 'required' })
    }
    return Object.freeze(missing)
  }

  update (partial: Partial<{ networkInit: NetworkInit; user: User }>): this {
    return new NetworksCreateBuilder(this.engine, { ...this.draft, ...partial }) as this
  }

  reset (): this {
    return new NetworksCreateBuilder(this.engine) as this
  }

  clone (): this {
    return new NetworksCreateBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Partial<{ networkInit: NetworkInit; user: User }>> {
    return {
      kind: NetworksCreateBuilder.KIND,
      version: NetworksCreateBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {
    // Reserved no-op per CONTEXT.md
  }

  fromPayload (payload: { networkInit: NetworkInit; user: User }): this {
    return new NetworksCreateBuilder(this.engine, {
      networkInit: payload.networkInit,
      user: payload.user
    }) as this
  }

  // ---- static methods ----

  static fromJSON (json: SerializedBuilder<unknown>, engine: INetworksEngine): NetworksCreateBuilder {
    if (json.kind !== NetworksCreateBuilder.KIND) {
      throw new Error(
        `NetworksCreateBuilder.fromJSON: unknown kind "${json.kind}" (expected "${NetworksCreateBuilder.KIND}")`
      )
    }
    if (json.version !== NetworksCreateBuilder.KIND_VERSION) {
      throw new Error(
        `NetworksCreateBuilder.fromJSON: unsupported version ${json.version} (expected ${NetworksCreateBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error(
        'NetworksCreateBuilder.fromJSON: draft must be a plain object'
      )
    }
    return new NetworksCreateBuilder(engine, draft as Partial<{ networkInit: NetworkInit; user: User }>)
  }
}
