/**
 * Phase 10 -- BUILD-TASK-01 / FACT-02 / FACT-03 / VALID-01..03 / SER-01..04.
 * Concrete SetOnboardingTaskCompletedBuilder implementing
 * IOnboardingTasksSetOnboardingTaskCompletedBuilder as an additive layer over
 * OnboardingTasksEngine.setOnboardingTaskCompleted.
 */

import type {
  BuilderError,
  IOnboardingTasksEngine,
  IOnboardingTasksSetOnboardingTaskCompletedBuilder,
  MissingField,
  SerializedBuilder
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

type Draft = Readonly<Partial<{ taskId: string }>>
type DraftValidator = (draft: Draft) => BuilderError[]

export class SetOnboardingTaskCompletedBuilder implements IOnboardingTasksSetOnboardingTaskCompletedBuilder {
  static readonly KIND = 'tasks.setOnboardingTaskCompleted'
  static readonly KIND_VERSION = 1

  private committed = false
  private cachedOutput: void | undefined = undefined

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    SetOnboardingTaskCompletedBuilder.validateTaskId,
    SetOnboardingTaskCompletedBuilder.validateCrossField
  ]

  constructor (
    private readonly engine: IOnboardingTasksEngine,
    private readonly draft: Draft = {}
  ) {}

  // ---- per-setter validators ----

  private static validateTaskId (draft: Draft): BuilderError[] {
    if (draft.taskId === undefined) return []
    if (typeof draft.taskId !== 'string' || draft.taskId.trim() === '') {
      return [{
        path: 'taskId',
        code: 'EMPTY',
        message: 'taskId required',
        kind: 'per-setter'
      }]
    }
    return []
  }

  private static validateCrossField (_draft: Draft): BuilderError[] {
    return []
  }

  // ---- private helpers ----

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of SetOnboardingTaskCompletedBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- IBuilder<string, void> surface ----

  setTaskId (taskId: string): this {
    return new SetOnboardingTaskCompletedBuilder(this.engine, { ...this.draft, taskId }) as this
  }

  build (): string {
    return this.toEngineInput()
  }

  toEngineInput (): string {
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
    return this.draft.taskId!
  }

  commit (): Promise<void> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(SetOnboardingTaskCompletedBuilder.KIND)
    }
    const input = this.toEngineInput()
    this.committed = true
    const result = this.engine.setOnboardingTaskCompleted(input)
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
    if (this.draft.taskId === undefined) {
      missing.push({ path: 'taskId', reason: 'required' })
    }
    return Object.freeze(missing)
  }

  update (partial: Partial<string>): this {
    // String TInput: update replaces the taskId if a string is provided
    if (typeof partial === 'string') {
      return new SetOnboardingTaskCompletedBuilder(this.engine, { taskId: partial }) as this
    }
    return new SetOnboardingTaskCompletedBuilder(this.engine, { ...this.draft }) as this
  }

  reset (): this {
    return new SetOnboardingTaskCompletedBuilder(this.engine) as this
  }

  clone (): this {
    return new SetOnboardingTaskCompletedBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Draft> {
    return {
      kind: SetOnboardingTaskCompletedBuilder.KIND,
      version: SetOnboardingTaskCompletedBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {
    // Reserved no-op per CONTEXT.md
  }

  fromPayload (payload: string): this {
    return new SetOnboardingTaskCompletedBuilder(this.engine, { taskId: payload }) as this
  }

  // ---- static methods ----

  static fromJSON (json: SerializedBuilder<unknown>, engine: IOnboardingTasksEngine): SetOnboardingTaskCompletedBuilder {
    if (json.kind !== SetOnboardingTaskCompletedBuilder.KIND) {
      throw new Error(
        `SetOnboardingTaskCompletedBuilder.fromJSON: unknown kind "${json.kind}" (expected "${SetOnboardingTaskCompletedBuilder.KIND}")`
      )
    }
    if (json.version !== SetOnboardingTaskCompletedBuilder.KIND_VERSION) {
      throw new Error(
        `SetOnboardingTaskCompletedBuilder.fromJSON: unsupported version ${json.version} (expected ${SetOnboardingTaskCompletedBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error(
        'SetOnboardingTaskCompletedBuilder.fromJSON: draft must be a plain object'
      )
    }
    return new SetOnboardingTaskCompletedBuilder(engine, draft as Draft)
  }
}
