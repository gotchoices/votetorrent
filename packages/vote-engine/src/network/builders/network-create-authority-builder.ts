/**
 * Phase 08 -- BUILD-NET-02 / FACT-02..04 / VALID-01..03 / SER-01..04.
 * Concrete NetworkCreateAuthorityBuilder implementing
 * INetworkCreateAuthorityBuilder as an additive layer over
 * NetworkEngine.createAuthority.
 */

import type {
  AdminInit,
  AuthorityInit,
  BuilderError,
  INetworkCreateAuthorityBuilder,
  INetworkEngine,
  MissingField,
  SerializedBuilder
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

interface CreateAuthorityDraft {
  authority?: AuthorityInit
  admin?: AdminInit
}

type Draft = Readonly<CreateAuthorityDraft>
type DraftValidator = (draft: Draft) => BuilderError[]

export class NetworkCreateAuthorityBuilder implements INetworkCreateAuthorityBuilder {
  static readonly KIND = 'network.createAuthority'
  static readonly KIND_VERSION = 1

  private committed = false
  private cachedOutput: void | undefined = undefined

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    NetworkCreateAuthorityBuilder.validateAuthority,
    NetworkCreateAuthorityBuilder.validateAdmin
  ]

  constructor (
    private readonly engine: INetworkEngine,
    private readonly draft: Draft = {}
  ) {}

  // ---- per-setter validators ----

  private static validateAuthority (draft: Draft): BuilderError[] {
    const a = draft.authority
    if (a === undefined || a === null) return []
    const errors: BuilderError[] = []

    if (typeof a !== 'object' || Array.isArray(a)) {
      errors.push({
        path: 'authority',
        code: 'INVALID',
        message: 'authority must be a plain object',
        kind: 'per-setter'
      })
      return errors
    }

    if (typeof a.name !== 'string' || a.name.trim() === '') {
      errors.push({
        path: 'authority.name',
        code: 'EMPTY',
        message: 'authority.name must be a non-empty string',
        kind: 'per-setter'
      })
    }

    if (typeof a.domainName !== 'string' || a.domainName.trim() === '') {
      errors.push({
        path: 'authority.domainName',
        code: 'EMPTY',
        message: 'authority.domainName must be a non-empty string',
        kind: 'per-setter'
      })
    }

    return errors
  }

  private static validateAdmin (draft: Draft): BuilderError[] {
    const ad = draft.admin
    if (ad === undefined || ad === null) return []
    const errors: BuilderError[] = []

    if (typeof ad !== 'object' || Array.isArray(ad)) {
      errors.push({
        path: 'admin',
        code: 'INVALID',
        message: 'admin must be a plain object',
        kind: 'per-setter'
      })
      return errors
    }

    if (!Array.isArray(ad.officers) || ad.officers.length === 0) {
      errors.push({
        path: 'admin.officers',
        code: 'EMPTY',
        message: 'admin.officers must be a non-empty array',
        kind: 'per-setter'
      })
    }

    return errors
  }

  // ---- private helpers ----

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of NetworkCreateAuthorityBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- IBuilder<{ authority: AuthorityInit; admin: AdminInit }, void> ----

  setAuthority (authority: AuthorityInit): this {
    return new NetworkCreateAuthorityBuilder(this.engine, { ...this.draft, authority }) as this
  }

  setAdmin (admin: AdminInit): this {
    return new NetworkCreateAuthorityBuilder(this.engine, { ...this.draft, admin }) as this
  }

  build (): { authority: AuthorityInit; admin: AdminInit } {
    return this.toEngineInput()
  }

  toEngineInput (): { authority: AuthorityInit; admin: AdminInit } {
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
      authority: this.draft.authority!,
      admin: this.draft.admin!
    }
  }

  commit (options?: { inviteSlotCid?: string; inviteSignature?: string }): Promise<void> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(NetworkCreateAuthorityBuilder.KIND)
    }
    const input = this.toEngineInput()
    this.committed = true
    // FACT-02: delegate verbatim to engine.createAuthority(authority, admin, options)
    const result = this.engine.createAuthority(input.authority, input.admin, options)
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
    if (this.draft.authority === undefined || this.draft.authority === null) {
      missing.push({ path: 'authority', reason: 'required' })
    }
    if (this.draft.admin === undefined || this.draft.admin === null) {
      missing.push({ path: 'admin', reason: 'required' })
    }
    return Object.freeze(missing)
  }

  update (partial: Partial<{ authority: AuthorityInit; admin: AdminInit }>): this {
    return new NetworkCreateAuthorityBuilder(this.engine, { ...this.draft, ...partial }) as this
  }

  reset (): this {
    return new NetworkCreateAuthorityBuilder(this.engine) as this
  }

  clone (): this {
    return new NetworkCreateAuthorityBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<CreateAuthorityDraft> {
    return {
      kind: NetworkCreateAuthorityBuilder.KIND,
      version: NetworkCreateAuthorityBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {
    // Reserved no-op per CONTEXT.md
  }

  fromPayload (payload: { authority: AuthorityInit; admin: AdminInit }): this {
    return new NetworkCreateAuthorityBuilder(this.engine, {
      authority: payload.authority,
      admin: payload.admin
    }) as this
  }

  // ---- static methods ----

  static fromJSON (json: SerializedBuilder<unknown>, engine: INetworkEngine): NetworkCreateAuthorityBuilder {
    if (json.kind !== NetworkCreateAuthorityBuilder.KIND) {
      throw new Error(
        `NetworkCreateAuthorityBuilder.fromJSON: unknown kind "${json.kind}" (expected "${NetworkCreateAuthorityBuilder.KIND}")`
      )
    }
    if (json.version !== NetworkCreateAuthorityBuilder.KIND_VERSION) {
      throw new Error(
        `NetworkCreateAuthorityBuilder.fromJSON: unsupported version ${json.version} (expected ${NetworkCreateAuthorityBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error(
        'NetworkCreateAuthorityBuilder.fromJSON: draft must be a plain object'
      )
    }
    return new NetworkCreateAuthorityBuilder(engine, draft as CreateAuthorityDraft)
  }
}
