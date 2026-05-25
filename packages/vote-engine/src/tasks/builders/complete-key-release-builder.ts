/**
 * Phase 10 -- BUILD-TASK-01 / FACT-02 / FACT-03 / VALID-01..03 / SER-01..04.
 * Concrete CompleteKeyReleaseBuilder implementing
 * IKeysTasksCompleteKeyReleaseBuilder as an additive layer over
 * KeysTasksEngine.completeKeyRelease.
 */

import type {
  BuilderError,
  IKeysTasksEngine,
  IKeysTasksCompleteKeyReleaseBuilder,
  MissingField,
  ReleaseKeyTask,
  SerializedBuilder
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

type Draft = Readonly<Partial<{ task: ReleaseKeyTask }>>
type DraftValidator = (draft: Draft) => BuilderError[]

export class CompleteKeyReleaseBuilder implements IKeysTasksCompleteKeyReleaseBuilder {
  static readonly KIND = 'tasks.completeKeyRelease'
  static readonly KIND_VERSION = 1

  private committed = false
  private cachedOutput: void | undefined = undefined

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    CompleteKeyReleaseBuilder.validateTask,
    CompleteKeyReleaseBuilder.validateCrossField
  ]

  constructor (
    private readonly engine: IKeysTasksEngine,
    private readonly draft: Draft = {}
  ) {}

  // ---- per-setter validators ----

  private static validateTask (draft: Draft): BuilderError[] {
    if (draft.task === undefined) return []
    const t = draft.task
    if (t.type !== 'release-key') {
      return [{
        path: 'task.type',
        code: 'INVALID',
        message: 'task.type must be "release-key"',
        kind: 'per-setter'
      }]
    }
    const errors: BuilderError[] = []
    if (!t.userId || typeof t.userId !== 'string' || t.userId.trim() === '') {
      errors.push({
        path: 'task.userId',
        code: 'EMPTY',
        message: 'task.userId required',
        kind: 'per-setter'
      })
    }
    if (!t.network) {
      errors.push({
        path: 'task.network',
        code: 'MISSING',
        message: 'task.network required',
        kind: 'per-setter'
      })
    }
    if (!t.election) {
      errors.push({
        path: 'task.election',
        code: 'MISSING',
        message: 'task.election required',
        kind: 'per-setter'
      })
    }
    return errors
  }

  private static validateCrossField (_draft: Draft): BuilderError[] {
    return []
  }

  // ---- private helpers ----

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of CompleteKeyReleaseBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- IBuilder<ReleaseKeyTask, void> surface ----

  setTask (task: ReleaseKeyTask): this {
    return new CompleteKeyReleaseBuilder(this.engine, { ...this.draft, task }) as this
  }

  build (): ReleaseKeyTask {
    return this.toEngineInput()
  }

  toEngineInput (): ReleaseKeyTask {
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
    return this.draft.task!
  }

  commit (): Promise<void> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(CompleteKeyReleaseBuilder.KIND)
    }
    const input = this.toEngineInput()
    this.committed = true
    const result = this.engine.completeKeyRelease(input)
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
    if (this.draft.task === undefined) {
      missing.push({ path: 'task', reason: 'required' })
    }
    return Object.freeze(missing)
  }

  update (partial: Partial<ReleaseKeyTask>): this {
    const merged = this.draft.task
      ? { task: { ...this.draft.task, ...partial } }
      : { task: partial as ReleaseKeyTask }
    return new CompleteKeyReleaseBuilder(this.engine, merged) as this
  }

  reset (): this {
    return new CompleteKeyReleaseBuilder(this.engine) as this
  }

  clone (): this {
    return new CompleteKeyReleaseBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Draft> {
    return {
      kind: CompleteKeyReleaseBuilder.KIND,
      version: CompleteKeyReleaseBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {
    // Reserved no-op per CONTEXT.md
  }

  fromPayload (payload: ReleaseKeyTask): this {
    return new CompleteKeyReleaseBuilder(this.engine, { task: payload }) as this
  }

  // ---- static methods ----

  static fromJSON (json: SerializedBuilder<unknown>, engine: IKeysTasksEngine): CompleteKeyReleaseBuilder {
    if (json.kind !== CompleteKeyReleaseBuilder.KIND) {
      throw new Error(
        `CompleteKeyReleaseBuilder.fromJSON: unknown kind "${json.kind}" (expected "${CompleteKeyReleaseBuilder.KIND}")`
      )
    }
    if (json.version !== CompleteKeyReleaseBuilder.KIND_VERSION) {
      throw new Error(
        `CompleteKeyReleaseBuilder.fromJSON: unsupported version ${json.version} (expected ${CompleteKeyReleaseBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error(
        'CompleteKeyReleaseBuilder.fromJSON: draft must be a plain object'
      )
    }
    return new CompleteKeyReleaseBuilder(engine, draft as Draft)
  }
}
