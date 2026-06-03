/**
 * Phase 08 -- BUILD-ELEC-02 / FACT-02..04 / VALID-01..03 / SER-01,02,04.
 * Concrete ElectionInviteKeyholderBuilder implementing
 * IElectionInviteKeyholderBuilder as an additive layer over
 * ElectionEngine.inviteKeyholder.
 */

import type {
  BuilderError,
  IElectionEngine,
  IElectionInviteKeyholderBuilder,
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

export class ElectionInviteKeyholderBuilder implements IElectionInviteKeyholderBuilder {
  static readonly KIND = 'election.inviteKeyholder'
  static readonly KIND_VERSION = 1

  private committed = false

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    ElectionInviteKeyholderBuilder.validateKeyholder,
    ElectionInviteKeyholderBuilder.validateElectionId
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
    for (const validator of ElectionInviteKeyholderBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- setters ----

  setKeyholder (keyholder: KeyholderInvite): this {
    return new ElectionInviteKeyholderBuilder(this.engine, { ...this.draft, keyholder }) as this
  }

  setElectionId (electionId: string): this {
    return new ElectionInviteKeyholderBuilder(this.engine, { ...this.draft, electionId }) as this
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
      throw new BuilderAlreadyCommittedError(ElectionInviteKeyholderBuilder.KIND)
    }
    const input = this.toEngineInput()
    this.committed = true
    return this.engine.inviteKeyholder(input.keyholder, input.electionId)
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
    return new ElectionInviteKeyholderBuilder(this.engine, { ...this.draft, ...partial }) as this
  }

  reset (): this {
    return new ElectionInviteKeyholderBuilder(this.engine) as this
  }

  clone (): this {
    return new ElectionInviteKeyholderBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Draft> {
    return {
      kind: ElectionInviteKeyholderBuilder.KIND,
      version: ElectionInviteKeyholderBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {}

  fromPayload (payload: { keyholder: KeyholderInvite; electionId: string }): this {
    return new ElectionInviteKeyholderBuilder(this.engine, {
      keyholder: payload.keyholder,
      electionId: payload.electionId
    }) as this
  }

  static fromJSON (json: SerializedBuilder<unknown>, engine: IElectionEngine): ElectionInviteKeyholderBuilder {
    if (json.kind !== ElectionInviteKeyholderBuilder.KIND) {
      throw new Error(
        `ElectionInviteKeyholderBuilder.fromJSON: unknown kind "${json.kind}" (expected "${ElectionInviteKeyholderBuilder.KIND}")`
      )
    }
    if (json.version !== ElectionInviteKeyholderBuilder.KIND_VERSION) {
      throw new Error(
        `ElectionInviteKeyholderBuilder.fromJSON: unsupported version ${json.version} (expected ${ElectionInviteKeyholderBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error('ElectionInviteKeyholderBuilder.fromJSON: draft must be a plain object')
    }
    return new ElectionInviteKeyholderBuilder(engine, draft as Draft)
  }
}
