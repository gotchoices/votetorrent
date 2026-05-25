/**
 * Phase 08 -- BUILD-ELEC-01 / FACT-02..04 / VALID-01..03 / SER-01,02,04.
 * Concrete ElectionsAdjustElectionBuilder implementing
 * IElectionsAdjustElectionBuilder as an additive layer over
 * ElectionsEngine.adjustElection.
 */

import type {
  BuilderError,
  ElectionCoreInit,
  ElectionInit,
  ElectionRevisionInit,
  IElectionsAdjustElectionBuilder,
  IElectionsEngine,
  MissingField,
  SerializedBuilder
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

interface Draft {
  election?: ElectionCoreInit
  revision?: ElectionRevisionInit
}

type FrozenDraft = Readonly<Draft>
type DraftValidator = (draft: FrozenDraft) => BuilderError[]

export class ElectionsAdjustElectionBuilder implements IElectionsAdjustElectionBuilder {
  static readonly KIND = 'elections.adjustElection'
  static readonly KIND_VERSION = 1

  private committed = false

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    ElectionsAdjustElectionBuilder.validateElection,
    ElectionsAdjustElectionBuilder.validateRevision,
    ElectionsAdjustElectionBuilder.validateCrossField
  ]

  constructor (
    private readonly engine: IElectionsEngine,
    private readonly draft: FrozenDraft = {}
  ) {}

  // ---- per-setter validators ----

  private static validateElection (draft: FrozenDraft): BuilderError[] {
    if (draft.election === undefined) return []
    const errors: BuilderError[] = []
    const e = draft.election
    if (typeof e.id !== 'string' || e.id.trim() === '') {
      errors.push({ path: 'election.id', code: 'EMPTY', message: 'election.id required', kind: 'per-setter' })
    }
    if (typeof e.authorityId !== 'string' || e.authorityId.trim() === '') {
      errors.push({ path: 'election.authorityId', code: 'EMPTY', message: 'election.authorityId required', kind: 'per-setter' })
    }
    if (typeof e.title !== 'string' || e.title.trim() === '') {
      errors.push({ path: 'election.title', code: 'EMPTY', message: 'election.title required', kind: 'per-setter' })
    }
    if (typeof e.date !== 'number' || e.date <= 0) {
      errors.push({ path: 'election.date', code: 'INVALID', message: 'election.date must be a positive number', kind: 'per-setter' })
    }
    if (typeof e.revisionDeadline !== 'number' || e.revisionDeadline <= 0) {
      errors.push({ path: 'election.revisionDeadline', code: 'INVALID', message: 'election.revisionDeadline must be a positive number', kind: 'per-setter' })
    }
    if (typeof e.ballotDeadline !== 'number' || e.ballotDeadline <= 0) {
      errors.push({ path: 'election.ballotDeadline', code: 'INVALID', message: 'election.ballotDeadline must be a positive number', kind: 'per-setter' })
    }
    return errors
  }

  private static validateRevision (draft: FrozenDraft): BuilderError[] {
    if (draft.revision === undefined) return []
    const errors: BuilderError[] = []
    const r = draft.revision
    if (typeof r.electionId !== 'string' || r.electionId.trim() === '') {
      errors.push({ path: 'revision.electionId', code: 'EMPTY', message: 'revision.electionId required', kind: 'per-setter' })
    }
    if (typeof r.instructions !== 'string') {
      errors.push({ path: 'revision.instructions', code: 'INVALID', message: 'revision.instructions must be a string', kind: 'per-setter' })
    }
    if (!Array.isArray(r.keyholders)) {
      errors.push({ path: 'revision.keyholders', code: 'INVALID', message: 'revision.keyholders must be an array', kind: 'per-setter' })
    }
    if (r.timeline === null || typeof r.timeline !== 'object' || Array.isArray(r.timeline)) {
      errors.push({ path: 'revision.timeline', code: 'INVALID', message: 'revision.timeline must be an object', kind: 'per-setter' })
    }
    return errors
  }

  private static validateCrossField (draft: FrozenDraft): BuilderError[] {
    if (draft.revision === undefined) return []
    const errors: BuilderError[] = []
    const r = draft.revision
    if (
      Array.isArray(r.keyholders) &&
      typeof r.keyholderThreshold === 'number' &&
      r.keyholderThreshold > r.keyholders.length
    ) {
      errors.push({
        path: 'revision.keyholderThreshold',
        code: 'THRESHOLD_EXCEEDS_KEYHOLDERS',
        message: `keyholderThreshold (${r.keyholderThreshold}) exceeds keyholders count (${r.keyholders.length})`,
        kind: 'cross-field'
      })
    }
    if (r.timeline && typeof r.timeline === 'object' && !Array.isArray(r.timeline)) {
      const t = r.timeline as Record<string, number>
      const ordered: Array<[string, string]> = [
        ['votingStarts', 'tallyingStarts'],
        ['tallyingStarts', 'certificationStarts']
      ]
      for (const [before, after] of ordered) {
        if (
          typeof t[before] === 'number' &&
          typeof t[after] === 'number' &&
          t[before] >= t[after]
        ) {
          errors.push({
            path: `revision.timeline.${after}`,
            code: 'TIMELINE_ORDER',
            message: `${after} must be after ${before}`,
            kind: 'cross-field'
          })
        }
      }
    }
    return errors
  }

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of ElectionsAdjustElectionBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- IBuilder<ElectionInit, void> surface ----

  setElection (election: ElectionCoreInit): this {
    return new ElectionsAdjustElectionBuilder(this.engine, { ...this.draft, election }) as this
  }

  setRevision (revision: ElectionRevisionInit): this {
    return new ElectionsAdjustElectionBuilder(this.engine, { ...this.draft, revision }) as this
  }

  build (): ElectionInit {
    return this.toEngineInput()
  }

  toEngineInput (): ElectionInit {
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
      election: this.draft.election!,
      revision: this.draft.revision!
    }
  }

  commit (): Promise<void> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(ElectionsAdjustElectionBuilder.KIND)
    }
    this.toEngineInput()
    this.committed = true
    return this.engine.adjustElection(this.toEngineInput())
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
    if (this.draft.election === undefined) {
      missing.push({ path: 'election', reason: 'required' })
    }
    if (this.draft.revision === undefined) {
      missing.push({ path: 'revision', reason: 'required' })
    }
    return Object.freeze(missing)
  }

  update (partial: Partial<ElectionInit>): this {
    return new ElectionsAdjustElectionBuilder(this.engine, { ...this.draft, ...partial }) as this
  }

  reset (): this {
    return new ElectionsAdjustElectionBuilder(this.engine) as this
  }

  clone (): this {
    return new ElectionsAdjustElectionBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Draft> {
    return {
      kind: ElectionsAdjustElectionBuilder.KIND,
      version: ElectionsAdjustElectionBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {}

  fromPayload (payload: ElectionInit): this {
    return new ElectionsAdjustElectionBuilder(this.engine, {
      election: payload.election,
      revision: payload.revision
    }) as this
  }

  static fromJSON (json: SerializedBuilder<unknown>, engine: IElectionsEngine): ElectionsAdjustElectionBuilder {
    if (json.kind !== ElectionsAdjustElectionBuilder.KIND) {
      throw new Error(
        `ElectionsAdjustElectionBuilder.fromJSON: unknown kind "${json.kind}" (expected "${ElectionsAdjustElectionBuilder.KIND}")`
      )
    }
    if (json.version !== ElectionsAdjustElectionBuilder.KIND_VERSION) {
      throw new Error(
        `ElectionsAdjustElectionBuilder.fromJSON: unsupported version ${json.version} (expected ${ElectionsAdjustElectionBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error('ElectionsAdjustElectionBuilder.fromJSON: draft must be a plain object')
    }
    return new ElectionsAdjustElectionBuilder(engine, draft as Draft)
  }
}
