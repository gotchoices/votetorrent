/**
 * Phase 08 -- BUILD-ELEC-02 / FACT-02..04 / VALID-01..03 / SER-01,02,04.
 * Concrete ElectionProposeRevisionBuilder implementing
 * IElectionProposeRevisionBuilder as an additive layer over
 * ElectionEngine.proposeRevision.
 */

import type {
  BuilderError,
  ElectionEvent,
  ElectionRevisionInit,
  IElectionEngine,
  IElectionProposeRevisionBuilder,
  KeyholderInvite,
  MissingField,
  SerializedBuilder,
  Timestamp
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

type FrozenDraft = Readonly<Partial<ElectionRevisionInit>>
type DraftValidator = (draft: FrozenDraft) => BuilderError[]

export class ElectionProposeRevisionBuilder implements IElectionProposeRevisionBuilder {
  static readonly KIND = 'election.proposeRevision'
  static readonly KIND_VERSION = 1

  private committed = false

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    ElectionProposeRevisionBuilder.validateElectionId,
    ElectionProposeRevisionBuilder.validateInstructions,
    ElectionProposeRevisionBuilder.validateKeyholders,
    ElectionProposeRevisionBuilder.validateTimeline,
    ElectionProposeRevisionBuilder.validateCrossField
  ]

  constructor (
    private readonly engine: IElectionEngine,
    private readonly draft: FrozenDraft = {}
  ) {}

  // ---- per-setter validators ----

  private static validateElectionId (draft: FrozenDraft): BuilderError[] {
    if (draft.electionId === undefined) return []
    if (typeof draft.electionId !== 'string' || draft.electionId.trim() === '') {
      return [{ path: 'electionId', code: 'EMPTY', message: 'electionId required', kind: 'per-setter' }]
    }
    return []
  }

  private static validateInstructions (draft: FrozenDraft): BuilderError[] {
    if (draft.instructions === undefined) return []
    if (typeof draft.instructions !== 'string') {
      return [{ path: 'instructions', code: 'INVALID', message: 'instructions must be a string', kind: 'per-setter' }]
    }
    return []
  }

  private static validateKeyholders (draft: FrozenDraft): BuilderError[] {
    if (draft.keyholders === undefined) return []
    if (!Array.isArray(draft.keyholders)) {
      return [{ path: 'keyholders', code: 'INVALID', message: 'keyholders must be an array', kind: 'per-setter' }]
    }
    return []
  }

  private static validateTimeline (draft: FrozenDraft): BuilderError[] {
    if (draft.timeline === undefined) return []
    if (draft.timeline === null || typeof draft.timeline !== 'object' || Array.isArray(draft.timeline)) {
      return [{ path: 'timeline', code: 'INVALID', message: 'timeline must be an object', kind: 'per-setter' }]
    }
    return []
  }

  private static validateCrossField (draft: FrozenDraft): BuilderError[] {
    const errors: BuilderError[] = []
    // threshold <= keyholders.length
    if (
      Array.isArray(draft.keyholders) &&
      typeof draft.keyholderThreshold === 'number' &&
      draft.keyholderThreshold > draft.keyholders.length
    ) {
      errors.push({
        path: 'keyholderThreshold',
        code: 'THRESHOLD_EXCEEDS_KEYHOLDERS',
        message: `keyholderThreshold (${draft.keyholderThreshold}) exceeds keyholders count (${draft.keyholders.length})`,
        kind: 'cross-field'
      })
    }
    // timeline ordering
    if (draft.timeline && typeof draft.timeline === 'object' && !Array.isArray(draft.timeline)) {
      const t = draft.timeline as Record<string, number>
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
            path: `timeline.${after}`,
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
    for (const validator of ElectionProposeRevisionBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- setters ----

  setElectionId (electionId: string): this {
    return new ElectionProposeRevisionBuilder(this.engine, { ...this.draft, electionId }) as this
  }

  setRevision (revision: number): this {
    return new ElectionProposeRevisionBuilder(this.engine, { ...this.draft, revision }) as this
  }

  setRevisionTimestamp (timestamp: Timestamp): this {
    return new ElectionProposeRevisionBuilder(this.engine, { ...this.draft, revisionTimestamp: timestamp }) as this
  }

  setTags (tags: string[]): this {
    return new ElectionProposeRevisionBuilder(this.engine, { ...this.draft, tags }) as this
  }

  setInstructions (instructions: string): this {
    return new ElectionProposeRevisionBuilder(this.engine, { ...this.draft, instructions }) as this
  }

  setKeyholders (keyholders: KeyholderInvite[]): this {
    return new ElectionProposeRevisionBuilder(this.engine, { ...this.draft, keyholders }) as this
  }

  setTimeline (timeline: Record<ElectionEvent, number>): this {
    return new ElectionProposeRevisionBuilder(this.engine, { ...this.draft, timeline }) as this
  }

  setKeyholderThreshold (threshold: number): this {
    return new ElectionProposeRevisionBuilder(this.engine, { ...this.draft, keyholderThreshold: threshold }) as this
  }

  // ---- IBuilder<ElectionRevisionInit, void> surface ----

  build (): ElectionRevisionInit {
    return this.toEngineInput()
  }

  toEngineInput (): ElectionRevisionInit {
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
      electionId: this.draft.electionId!,
      revision: this.draft.revision!,
      revisionTimestamp: this.draft.revisionTimestamp!,
      tags: this.draft.tags!,
      instructions: this.draft.instructions!,
      keyholders: this.draft.keyholders!,
      timeline: this.draft.timeline!,
      keyholderThreshold: this.draft.keyholderThreshold!
    }
  }

  commit (): Promise<void> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(ElectionProposeRevisionBuilder.KIND)
    }
    this.toEngineInput()
    this.committed = true
    return this.engine.proposeRevision(this.toEngineInput())
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
    if (this.draft.electionId === undefined) missing.push({ path: 'electionId', reason: 'required' })
    if (this.draft.revision === undefined) missing.push({ path: 'revision', reason: 'required' })
    if (this.draft.revisionTimestamp === undefined) missing.push({ path: 'revisionTimestamp', reason: 'required' })
    if (this.draft.tags === undefined) missing.push({ path: 'tags', reason: 'required' })
    if (this.draft.instructions === undefined) missing.push({ path: 'instructions', reason: 'required' })
    if (this.draft.keyholders === undefined) missing.push({ path: 'keyholders', reason: 'required' })
    if (this.draft.timeline === undefined) missing.push({ path: 'timeline', reason: 'required' })
    if (this.draft.keyholderThreshold === undefined) missing.push({ path: 'keyholderThreshold', reason: 'required' })
    return Object.freeze(missing)
  }

  update (partial: Partial<ElectionRevisionInit>): this {
    return new ElectionProposeRevisionBuilder(this.engine, { ...this.draft, ...partial }) as this
  }

  reset (): this {
    return new ElectionProposeRevisionBuilder(this.engine) as this
  }

  clone (): this {
    return new ElectionProposeRevisionBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Partial<ElectionRevisionInit>> {
    return {
      kind: ElectionProposeRevisionBuilder.KIND,
      version: ElectionProposeRevisionBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {}

  fromPayload (payload: ElectionRevisionInit): this {
    return new ElectionProposeRevisionBuilder(this.engine, { ...payload }) as this
  }

  static fromJSON (json: SerializedBuilder<unknown>, engine: IElectionEngine): ElectionProposeRevisionBuilder {
    if (json.kind !== ElectionProposeRevisionBuilder.KIND) {
      throw new Error(
        `ElectionProposeRevisionBuilder.fromJSON: unknown kind "${json.kind}" (expected "${ElectionProposeRevisionBuilder.KIND}")`
      )
    }
    if (json.version !== ElectionProposeRevisionBuilder.KIND_VERSION) {
      throw new Error(
        `ElectionProposeRevisionBuilder.fromJSON: unsupported version ${json.version} (expected ${ElectionProposeRevisionBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error('ElectionProposeRevisionBuilder.fromJSON: draft must be a plain object')
    }
    return new ElectionProposeRevisionBuilder(engine, draft as Partial<ElectionRevisionInit>)
  }
}
