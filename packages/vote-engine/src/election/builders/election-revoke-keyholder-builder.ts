/**
 * Phase 08 -- BUILD-ELEC-02 / FACT-02..04 / VALID-01..03 / SER-01,02,04.
 * Concrete ElectionRevokeKeyholderBuilder implementing
 * IElectionRevokeKeyholderBuilder as an additive layer over
 * ElectionEngine.revokeKeyholder.
 */

import type {
  BuilderError,
  IElectionEngine,
  IElectionRevokeKeyholderBuilder,
  KeyholderInvite,
  MissingField,
  SerializedBuilder
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

interface Draft {
  keyholder?: KeyholderInvite
  electionId?: string
}

type FrozenDraft = Readonly<Draft>
type DraftValidator = (draft: FrozenDraft) => BuilderError[]

export class ElectionRevokeKeyholderBuilder implements IElectionRevokeKeyholderBuilder {
  static readonly KIND = 'election.revokeKeyholder'
  static readonly KIND_VERSION = 1

  private committed = false

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    ElectionRevokeKeyholderBuilder.validateKeyholder,
    ElectionRevokeKeyholderBuilder.validateElectionId
  ]

  constructor (
    private readonly engine: IElectionEngine,
    private readonly draft: FrozenDraft = {}
  ) {}

  // ---- per-setter validators ----

  private static validateKeyholder (draft: FrozenDraft): BuilderError[] {
    if (draft.keyholder === undefined) return []
    const errors: BuilderError[] = []
    if (typeof draft.keyholder.name !== 'string' || draft.keyholder.name.trim() === '') {
      errors.push({ path: 'keyholder.name', code: 'EMPTY', message: 'keyholder.name required', kind: 'per-setter' })
    }
    if (typeof draft.keyholder.inviteKey !== 'string' || draft.keyholder.inviteKey.trim() === '') {
      errors.push({ path: 'keyholder.inviteKey', code: 'EMPTY', message: 'keyholder.inviteKey required', kind: 'per-setter' })
    }
    return errors
  }

  private static validateElectionId (draft: FrozenDraft): BuilderError[] {
    if (draft.electionId === undefined) return []
    if (typeof draft.electionId !== 'string' || draft.electionId.trim() === '') {
      return [{ path: 'electionId', code: 'EMPTY', message: 'electionId required', kind: 'per-setter' }]
    }
    return []
  }

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of ElectionRevokeKeyholderBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- setters ----

  setKeyholder (keyholder: KeyholderInvite): this {
    return new ElectionRevokeKeyholderBuilder(this.engine, { ...this.draft, keyholder }) as this
  }

  setElectionId (electionId: string): this {
    return new ElectionRevokeKeyholderBuilder(this.engine, { ...this.draft, electionId }) as this
  }

  // ---- IBuilder<{ keyholder; electionId }, void> surface ----

  build (): { keyholder: KeyholderInvite; electionId: string } {
    return this.toEngineInput()
  }

  toEngineInput (): { keyholder: KeyholderInvite; electionId: string } {
    const errors = this.runValidators()
    const missing = this.missingFields()
    if (errors.length > 0 || missing.length > 0) {
      const allErrors: BuilderError[] = [...errors]
      for (const m of missing) {
        allErrors.push({ path: m.path, code: 'MISSING', message: m.reason, kind: 'per-setter' })
      }
      throw new BuilderValidationError(allErrors)
    }
    return {
      keyholder: this.draft.keyholder!,
      electionId: this.draft.electionId!
    }
  }

  commit (): Promise<void> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(ElectionRevokeKeyholderBuilder.KIND)
    }
    const input = this.toEngineInput()
    this.committed = true
    return this.engine.revokeKeyholder(input.keyholder, input.electionId)
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
    if (this.draft.keyholder === undefined) missing.push({ path: 'keyholder', reason: 'required' })
    if (this.draft.electionId === undefined) missing.push({ path: 'electionId', reason: 'required' })
    return Object.freeze(missing)
  }

  update (partial: Partial<{ keyholder: KeyholderInvite; electionId: string }>): this {
    return new ElectionRevokeKeyholderBuilder(this.engine, { ...this.draft, ...partial }) as this
  }

  reset (): this {
    return new ElectionRevokeKeyholderBuilder(this.engine) as this
  }

  clone (): this {
    return new ElectionRevokeKeyholderBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Draft> {
    return {
      kind: ElectionRevokeKeyholderBuilder.KIND,
      version: ElectionRevokeKeyholderBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {}

  fromPayload (payload: { keyholder: KeyholderInvite; electionId: string }): this {
    return new ElectionRevokeKeyholderBuilder(this.engine, {
      keyholder: payload.keyholder,
      electionId: payload.electionId
    }) as this
  }

  static fromJSON (json: SerializedBuilder<unknown>, engine: IElectionEngine): ElectionRevokeKeyholderBuilder {
    if (json.kind !== ElectionRevokeKeyholderBuilder.KIND) {
      throw new Error(
        `ElectionRevokeKeyholderBuilder.fromJSON: unknown kind "${json.kind}" (expected "${ElectionRevokeKeyholderBuilder.KIND}")`
      )
    }
    if (json.version !== ElectionRevokeKeyholderBuilder.KIND_VERSION) {
      throw new Error(
        `ElectionRevokeKeyholderBuilder.fromJSON: unsupported version ${json.version} (expected ${ElectionRevokeKeyholderBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error('ElectionRevokeKeyholderBuilder.fromJSON: draft must be a plain object')
    }
    return new ElectionRevokeKeyholderBuilder(engine, draft as Draft)
  }
}
