/**
 * Phase 08 -- BUILD-ELEC-02 / FACT-02..04 / VALID-01..03 / SER-01,02,04.
 * Concrete ElectionProposeBallotBuilder implementing
 * IElectionProposeBallotBuilder as an additive layer over
 * ElectionEngine.proposeBallot.
 */

import type {
  Ballot,
  BuilderError,
  IElectionEngine,
  IElectionProposeBallotBuilder,
  MissingField,
  Question,
  SerializedBuilder
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

type FrozenDraft = Readonly<Partial<Ballot>>
type DraftValidator = (draft: FrozenDraft) => BuilderError[]

export class ElectionProposeBallotBuilder implements IElectionProposeBallotBuilder {
  static readonly KIND = 'election.proposeBallot'
  static readonly KIND_VERSION = 1

  private committed = false

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    ElectionProposeBallotBuilder.validateId,
    ElectionProposeBallotBuilder.validateElectionId,
    ElectionProposeBallotBuilder.validateAuthorityId,
    ElectionProposeBallotBuilder.validateDescription,
    ElectionProposeBallotBuilder.validateQuestions,
    ElectionProposeBallotBuilder.validateCrossField
  ]

  constructor (
    private readonly engine: IElectionEngine,
    private readonly draft: FrozenDraft = {}
  ) {}

  // ---- per-setter validators ----

  private static validateId (draft: FrozenDraft): BuilderError[] {
    if (draft.id === undefined) return []
    if (typeof draft.id !== 'string' || draft.id.trim() === '') {
      return [{ path: 'id', code: 'EMPTY', message: 'id required', kind: 'per-setter' }]
    }
    return []
  }

  private static validateElectionId (draft: FrozenDraft): BuilderError[] {
    if (draft.electionId === undefined) return []
    if (typeof draft.electionId !== 'string' || draft.electionId.trim() === '') {
      return [{ path: 'electionId', code: 'EMPTY', message: 'electionId required', kind: 'per-setter' }]
    }
    return []
  }

  private static validateAuthorityId (draft: FrozenDraft): BuilderError[] {
    if (draft.authorityId === undefined) return []
    if (typeof draft.authorityId !== 'string' || draft.authorityId.trim() === '') {
      return [{ path: 'authorityId', code: 'EMPTY', message: 'authorityId required', kind: 'per-setter' }]
    }
    return []
  }

  private static validateDescription (draft: FrozenDraft): BuilderError[] {
    if (draft.description === undefined) return []
    if (typeof draft.description !== 'string' || draft.description.trim() === '') {
      return [{ path: 'description', code: 'EMPTY', message: 'description required', kind: 'per-setter' }]
    }
    return []
  }

  private static validateQuestions (draft: FrozenDraft): BuilderError[] {
    if (draft.questions === undefined) return []
    if (!Array.isArray(draft.questions)) {
      return [{ path: 'questions', code: 'INVALID', message: 'questions must be an array', kind: 'per-setter' }]
    }
    return []
  }

  private static validateCrossField (draft: FrozenDraft): BuilderError[] {
    if (draft.questions === undefined) return []
    if (Array.isArray(draft.questions) && draft.questions.length === 0) {
      return [{
        path: 'questions',
        code: 'NO_QUESTIONS',
        message: 'ballot must have at least one question',
        kind: 'cross-field'
      }]
    }
    return []
  }

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of ElectionProposeBallotBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- setters ----

  setId (id: string): this {
    return new ElectionProposeBallotBuilder(this.engine, { ...this.draft, id }) as this
  }

  setElectionId (electionId: string): this {
    return new ElectionProposeBallotBuilder(this.engine, { ...this.draft, electionId }) as this
  }

  setAuthorityId (authorityId: string): this {
    return new ElectionProposeBallotBuilder(this.engine, { ...this.draft, authorityId }) as this
  }

  setDescription (description: string): this {
    return new ElectionProposeBallotBuilder(this.engine, { ...this.draft, description }) as this
  }

  setDistricts (districts: string[]): this {
    return new ElectionProposeBallotBuilder(this.engine, { ...this.draft, districts }) as this
  }

  setQuestions (questions: Question[]): this {
    return new ElectionProposeBallotBuilder(this.engine, { ...this.draft, questions }) as this
  }

  // ---- IBuilder<Ballot, void> surface ----

  build (): Ballot {
    return this.toEngineInput()
  }

  toEngineInput (): Ballot {
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
      id: this.draft.id!,
      electionId: this.draft.electionId!,
      authorityId: this.draft.authorityId!,
      description: this.draft.description!,
      districts: this.draft.districts ?? [],
      questions: this.draft.questions!
    }
  }

  commit (): Promise<void> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(ElectionProposeBallotBuilder.KIND)
    }
    this.toEngineInput()
    this.committed = true
    return this.engine.proposeBallot(this.toEngineInput())
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
    if (this.draft.id === undefined) missing.push({ path: 'id', reason: 'required' })
    if (this.draft.electionId === undefined) missing.push({ path: 'electionId', reason: 'required' })
    if (this.draft.authorityId === undefined) missing.push({ path: 'authorityId', reason: 'required' })
    if (this.draft.description === undefined) missing.push({ path: 'description', reason: 'required' })
    if (this.draft.questions === undefined) missing.push({ path: 'questions', reason: 'required' })
    return Object.freeze(missing)
  }

  update (partial: Partial<Ballot>): this {
    return new ElectionProposeBallotBuilder(this.engine, { ...this.draft, ...partial }) as this
  }

  reset (): this {
    return new ElectionProposeBallotBuilder(this.engine) as this
  }

  clone (): this {
    return new ElectionProposeBallotBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Partial<Ballot>> {
    return {
      kind: ElectionProposeBallotBuilder.KIND,
      version: ElectionProposeBallotBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {}

  fromPayload (payload: Ballot): this {
    return new ElectionProposeBallotBuilder(this.engine, {
      id: payload.id,
      electionId: payload.electionId,
      authorityId: payload.authorityId,
      description: payload.description,
      districts: payload.districts,
      questions: payload.questions
    }) as this
  }

  static fromJSON (json: SerializedBuilder<unknown>, engine: IElectionEngine): ElectionProposeBallotBuilder {
    if (json.kind !== ElectionProposeBallotBuilder.KIND) {
      throw new Error(
        `ElectionProposeBallotBuilder.fromJSON: unknown kind "${json.kind}" (expected "${ElectionProposeBallotBuilder.KIND}")`
      )
    }
    if (json.version !== ElectionProposeBallotBuilder.KIND_VERSION) {
      throw new Error(
        `ElectionProposeBallotBuilder.fromJSON: unsupported version ${json.version} (expected ${ElectionProposeBallotBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error('ElectionProposeBallotBuilder.fromJSON: draft must be a plain object')
    }
    return new ElectionProposeBallotBuilder(engine, draft as Partial<Ballot>)
  }
}
