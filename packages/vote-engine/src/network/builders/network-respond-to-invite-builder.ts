/**
 * Phase 08 -- BUILD-NET-02 / FACT-02..04 / VALID-01..03 / SER-01..04.
 * Concrete NetworkRespondToInviteBuilder implementing
 * INetworkRespondToInviteBuilder<unknown> as an additive layer over
 * NetworkEngine.respondToInvite.
 *
 * The interface is generic (INetworkRespondToInviteBuilder<TInvokes>)
 * but the concrete class uses `unknown` internally. The factory method
 * on NetworkEngine casts to the caller's TInvokes.
 */

import type {
  BuilderError,
  InviteAction,
  INetworkEngine,
  INetworkRespondToInviteBuilder,
  MissingField,
  SerializedBuilder
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

type Draft = Readonly<Partial<InviteAction<unknown>>>
type DraftValidator = (draft: Draft) => BuilderError[]

export class NetworkRespondToInviteBuilder implements INetworkRespondToInviteBuilder<unknown> {
  static readonly KIND = 'network.respondToInvite'
  static readonly KIND_VERSION = 1

  private committed = false
  private cachedOutput: string | undefined = undefined

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    NetworkRespondToInviteBuilder.validateInvite,
    NetworkRespondToInviteBuilder.validateInviteSignature
  ]

  constructor (
    private readonly engine: INetworkEngine,
    private readonly draft: Draft = {}
  ) {}

  // ---- per-setter validators ----

  private static validateInvite (draft: Draft): BuilderError[] {
    const errors: BuilderError[] = []

    if (draft.invite !== undefined) {
      if (typeof draft.invite !== 'object' || draft.invite === null || Array.isArray(draft.invite)) {
        errors.push({
          path: 'invite',
          code: 'INVALID',
          message: 'invite must be a valid Invite object',
          kind: 'per-setter'
        })
      }
    }

    if (draft.isAccepted !== undefined && typeof draft.isAccepted !== 'boolean') {
      errors.push({
        path: 'isAccepted',
        code: 'INVALID',
        message: 'isAccepted must be a boolean',
        kind: 'per-setter'
      })
    }

    return errors
  }

  private static validateInviteSignature (draft: Draft): BuilderError[] {
    if (draft.inviteSignature === undefined) return []
    if (typeof draft.inviteSignature !== 'string' || draft.inviteSignature.trim() === '') {
      return [{
        path: 'inviteSignature',
        code: 'EMPTY',
        message: 'inviteSignature must be a non-empty string',
        kind: 'per-setter'
      }]
    }
    return []
  }

  // ---- private helpers ----

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of NetworkRespondToInviteBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- IBuilder<InviteAction<unknown>, string> ----

  setInvite (invite: InviteAction<unknown>): this {
    return new NetworkRespondToInviteBuilder(this.engine, { ...invite }) as this
  }

  build (): InviteAction<unknown> {
    return this.toEngineInput()
  }

  toEngineInput (): InviteAction<unknown> {
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
      invite: this.draft.invite!,
      isAccepted: this.draft.isAccepted!,
      inviteSignature: this.draft.inviteSignature!,
      invokes: this.draft.invokes,
      userInit: this.draft.userInit,
      userId: this.draft.userId
    }
  }

  commit (): Promise<string> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(NetworkRespondToInviteBuilder.KIND)
    }
    const input = this.toEngineInput()
    this.committed = true
    // FACT-02: delegate verbatim to engine.respondToInvite(invite)
    const promise = this.engine.respondToInvite(input)
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
    if (this.draft.invite === undefined || this.draft.invite === null) {
      missing.push({ path: 'invite', reason: 'required' })
    }
    if (this.draft.isAccepted === undefined || this.draft.isAccepted === null) {
      missing.push({ path: 'isAccepted', reason: 'required' })
    }
    if (this.draft.inviteSignature === undefined || this.draft.inviteSignature === null) {
      missing.push({ path: 'inviteSignature', reason: 'required' })
    }
    return Object.freeze(missing)
  }

  update (partial: Partial<InviteAction<unknown>>): this {
    return new NetworkRespondToInviteBuilder(this.engine, { ...this.draft, ...partial }) as this
  }

  reset (): this {
    return new NetworkRespondToInviteBuilder(this.engine) as this
  }

  clone (): this {
    return new NetworkRespondToInviteBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Partial<InviteAction<unknown>>> {
    // Exclude undefined fields so JSON round-trip is stable (SER-04).
    const draft: Partial<InviteAction<unknown>> = {}
    if (this.draft.invite !== undefined) draft.invite = this.draft.invite
    if (this.draft.isAccepted !== undefined) draft.isAccepted = this.draft.isAccepted
    if (this.draft.inviteSignature !== undefined) draft.inviteSignature = this.draft.inviteSignature
    if (this.draft.invokes !== undefined) draft.invokes = this.draft.invokes
    if (this.draft.userInit !== undefined) draft.userInit = this.draft.userInit
    if (this.draft.userId !== undefined) draft.userId = this.draft.userId
    return {
      kind: NetworkRespondToInviteBuilder.KIND,
      version: NetworkRespondToInviteBuilder.KIND_VERSION,
      draft
    }
  }

  dispose (): void {
    // Reserved no-op per CONTEXT.md
  }

  fromPayload (payload: InviteAction<unknown>): this {
    return new NetworkRespondToInviteBuilder(this.engine, {
      invite: payload.invite,
      isAccepted: payload.isAccepted,
      inviteSignature: payload.inviteSignature,
      invokes: payload.invokes,
      userInit: payload.userInit,
      userId: payload.userId
    }) as this
  }

  // ---- static methods ----

  static fromJSON (json: SerializedBuilder<unknown>, engine: INetworkEngine): NetworkRespondToInviteBuilder {
    if (json.kind !== NetworkRespondToInviteBuilder.KIND) {
      throw new Error(
        `NetworkRespondToInviteBuilder.fromJSON: unknown kind "${json.kind}" (expected "${NetworkRespondToInviteBuilder.KIND}")`
      )
    }
    if (json.version !== NetworkRespondToInviteBuilder.KIND_VERSION) {
      throw new Error(
        `NetworkRespondToInviteBuilder.fromJSON: unsupported version ${json.version} (expected ${NetworkRespondToInviteBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error(
        'NetworkRespondToInviteBuilder.fromJSON: draft must be a plain object'
      )
    }
    return new NetworkRespondToInviteBuilder(engine, draft as Partial<InviteAction<unknown>>)
  }
}
