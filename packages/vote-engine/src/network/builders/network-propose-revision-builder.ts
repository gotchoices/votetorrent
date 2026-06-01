/**
 * Phase 08 -- BUILD-NET-02 / FACT-02..04 / VALID-01..03 / SER-01..04.
 * Concrete NetworkProposeRevisionBuilder implementing
 * INetworkProposeRevisionBuilder as an additive layer over
 * NetworkEngine.proposeRevision.
 */

import type {
  BuilderError,
  ImageRef,
  INetworkEngine,
  INetworkProposeRevisionBuilder,
  MissingField,
  NetworkPolicies,
  NetworkRevision,
  SerializedBuilder
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

type Draft = Readonly<Partial<NetworkRevision>>
type DraftValidator = (draft: Draft) => BuilderError[]

export class NetworkProposeRevisionBuilder implements INetworkProposeRevisionBuilder {
  static readonly KIND = 'network.proposeRevision'
  static readonly KIND_VERSION = 1

  private committed = false
  private cachedOutput: void | undefined = undefined

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    NetworkProposeRevisionBuilder.validateName,
    NetworkProposeRevisionBuilder.validatePolicies,
    NetworkProposeRevisionBuilder.validateRelays,
    NetworkProposeRevisionBuilder.validateCrossField
  ]

  constructor (
    private readonly engine: INetworkEngine,
    private readonly draft: Draft = {}
  ) {}

  // ---- per-setter validators ----

  private static validateName (draft: Draft): BuilderError[] {
    if (draft.name === undefined) return []
    if (typeof draft.name !== 'string' || draft.name.trim() === '') {
      return [{
        path: 'name',
        code: 'EMPTY',
        message: 'name must be a non-empty string',
        kind: 'per-setter'
      }]
    }
    return []
  }

  private static validatePolicies (draft: Draft): BuilderError[] {
    if (draft.policies === undefined) return []
    const p = draft.policies
    const errors: BuilderError[] = []
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      errors.push({
        path: 'policies',
        code: 'INVALID',
        message: 'policies must be a valid object',
        kind: 'per-setter'
      })
      return errors
    }
    if (typeof p.numberRequiredTSAs !== 'number' || p.numberRequiredTSAs < 0) {
      errors.push({
        path: 'policies.numberRequiredTSAs',
        code: 'INVALID',
        message: 'policies.numberRequiredTSAs must be a non-negative number',
        kind: 'per-setter'
      })
    }
    if (!Array.isArray(p.timestampAuthorities)) {
      errors.push({
        path: 'policies.timestampAuthorities',
        code: 'INVALID',
        message: 'policies.timestampAuthorities must be an array',
        kind: 'per-setter'
      })
    }
    return errors
  }

  private static validateRelays (draft: Draft): BuilderError[] {
    if (draft.relays === undefined) return []
    if (!Array.isArray(draft.relays)) {
      return [{
        path: 'relays',
        code: 'INVALID',
        message: 'relays must be an array of strings',
        kind: 'per-setter'
      }]
    }
    return []
  }

  private static validateCrossField (draft: Draft): BuilderError[] {
    const errors: BuilderError[] = []
    if (draft.policies && draft.relays) {
      // TSA count mismatch
      if (
        typeof draft.policies.numberRequiredTSAs === 'number' &&
        Array.isArray(draft.policies.timestampAuthorities) &&
        draft.policies.numberRequiredTSAs > draft.policies.timestampAuthorities.length
      ) {
        errors.push({
          path: 'policies.numberRequiredTSAs',
          code: 'TSA_MISMATCH',
          message: `numberRequiredTSAs (${draft.policies.numberRequiredTSAs}) exceeds timestampAuthorities count (${draft.policies.timestampAuthorities.length})`,
          kind: 'cross-field'
        })
      }

      // Relays must be non-empty
      if (Array.isArray(draft.relays) && draft.relays.length === 0) {
        errors.push({
          path: 'relays',
          code: 'NO_RELAYS',
          message: 'relays must not be empty',
          kind: 'cross-field'
        })
      }
    }
    return errors
  }

  // ---- private helpers ----

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of NetworkProposeRevisionBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- IBuilder<NetworkRevision, void> ----

  setName (name: string): this {
    return new NetworkProposeRevisionBuilder(this.engine, { ...this.draft, name }) as this
  }

  setPolicies (policies: NetworkPolicies): this {
    return new NetworkProposeRevisionBuilder(this.engine, { ...this.draft, policies }) as this
  }

  setRelays (relays: string[]): this {
    return new NetworkProposeRevisionBuilder(this.engine, { ...this.draft, relays }) as this
  }

  setImageRef (imageRef: ImageRef | undefined): this {
    return new NetworkProposeRevisionBuilder(this.engine, { ...this.draft, imageRef }) as this
  }

  build (): NetworkRevision {
    return this.toEngineInput()
  }

  toEngineInput (): NetworkRevision {
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
      policies: this.draft.policies!,
      relays: this.draft.relays!,
      imageRef: this.draft.imageRef
    }
  }

  commit (): Promise<void> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(NetworkProposeRevisionBuilder.KIND)
    }
    const input = this.toEngineInput()
    this.committed = true
    // FACT-02: delegate verbatim to engine.proposeRevision(revision)
    const result = this.engine.proposeRevision(input)
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
    if (this.draft.name === undefined || this.draft.name === null) {
      missing.push({ path: 'name', reason: 'required' })
    }
    if (this.draft.policies === undefined || this.draft.policies === null) {
      missing.push({ path: 'policies', reason: 'required' })
    }
    if (this.draft.relays === undefined || this.draft.relays === null) {
      missing.push({ path: 'relays', reason: 'required' })
    }
    return Object.freeze(missing)
  }

  update (partial: Partial<NetworkRevision>): this {
    return new NetworkProposeRevisionBuilder(this.engine, { ...this.draft, ...partial }) as this
  }

  reset (): this {
    return new NetworkProposeRevisionBuilder(this.engine) as this
  }

  clone (): this {
    return new NetworkProposeRevisionBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Partial<NetworkRevision>> {
    return {
      kind: NetworkProposeRevisionBuilder.KIND,
      version: NetworkProposeRevisionBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {
    // Reserved no-op per CONTEXT.md
  }

  fromPayload (payload: NetworkRevision): this {
    return new NetworkProposeRevisionBuilder(this.engine, {
      name: payload.name,
      policies: payload.policies,
      relays: payload.relays,
      imageRef: payload.imageRef
    }) as this
  }

  // ---- static methods ----

  static fromJSON (json: SerializedBuilder<unknown>, engine: INetworkEngine): NetworkProposeRevisionBuilder {
    if (json.kind !== NetworkProposeRevisionBuilder.KIND) {
      throw new Error(
        `NetworkProposeRevisionBuilder.fromJSON: unknown kind "${json.kind}" (expected "${NetworkProposeRevisionBuilder.KIND}")`
      )
    }
    if (json.version !== NetworkProposeRevisionBuilder.KIND_VERSION) {
      throw new Error(
        `NetworkProposeRevisionBuilder.fromJSON: unsupported version ${json.version} (expected ${NetworkProposeRevisionBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error(
        'NetworkProposeRevisionBuilder.fromJSON: draft must be a plain object'
      )
    }
    return new NetworkProposeRevisionBuilder(engine, draft as Partial<NetworkRevision>)
  }
}
