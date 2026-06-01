/**
 * Phase 10 -- BUILD-TASK-01 / FACT-02 / FACT-03 / VALID-01..03 / SER-01..04.
 * Concrete CompleteSignatureBuilder implementing
 * ISignatureTasksCompleteSignatureBuilder as an additive layer over
 * SignatureTasksEngine.completeSignature.
 */

import type {
  BuilderError,
  ISignatureTasksEngine,
  ISignatureTasksCompleteSignatureBuilder,
  MissingField,
  SerializedBuilder,
  SignatureResult,
  SignatureTask
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

type Draft = Readonly<Partial<{ task: SignatureTask; result: SignatureResult }>>
type DraftValidator = (draft: Draft) => BuilderError[]

const VALID_SIGNATURE_TYPES = new Set([
  'admin', 'authority', 'ballot', 'election', 'election-revision', 'network'
])

export class CompleteSignatureBuilder implements ISignatureTasksCompleteSignatureBuilder {
  static readonly KIND = 'tasks.completeSignature'
  static readonly KIND_VERSION = 1

  private committed = false
  private cachedOutput: void | undefined = undefined

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    CompleteSignatureBuilder.validateTask,
    CompleteSignatureBuilder.validateResult,
    CompleteSignatureBuilder.validateCrossField
  ]

  constructor (
    private readonly engine: ISignatureTasksEngine,
    private readonly draft: Draft = {}
  ) {}

  // ---- per-setter validators ----

  private static validateTask (draft: Draft): BuilderError[] {
    if (draft.task === undefined) return []
    const t = draft.task
    if (t.type !== 'signature') {
      return [{
        path: 'task.type',
        code: 'INVALID',
        message: 'task.type must be "signature"',
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
    if (!t.signatureType || !VALID_SIGNATURE_TYPES.has(t.signatureType)) {
      errors.push({
        path: 'task.signatureType',
        code: 'INVALID',
        message: 'task.signatureType must be one of: admin, authority, ballot, election, election-revision, network',
        kind: 'per-setter'
      })
    }
    return errors
  }

  private static validateResult (draft: Draft): BuilderError[] {
    if (draft.result === undefined) return []
    const r = draft.result
    const errors: BuilderError[] = []
    if (typeof r.isAccepted !== 'boolean') {
      errors.push({
        path: 'result.isAccepted',
        code: 'INVALID',
        message: 'result.isAccepted must be a boolean',
        kind: 'per-setter'
      })
    }
    if (!r.signature || typeof r.signature !== 'object') {
      errors.push({
        path: 'result.signature',
        code: 'MISSING',
        message: 'result.signature required',
        kind: 'per-setter'
      })
    } else {
      if (!r.signature.signature || typeof r.signature.signature !== 'string') {
        errors.push({
          path: 'result.signature.signature',
          code: 'EMPTY',
          message: 'result.signature.signature required',
          kind: 'per-setter'
        })
      }
      if (!r.signature.signerKey || typeof r.signature.signerKey !== 'string') {
        errors.push({
          path: 'result.signature.signerKey',
          code: 'EMPTY',
          message: 'result.signature.signerKey required',
          kind: 'per-setter'
        })
      }
      if (!r.signature.signerUserId || typeof r.signature.signerUserId !== 'string') {
        errors.push({
          path: 'result.signature.signerUserId',
          code: 'EMPTY',
          message: 'result.signature.signerUserId required',
          kind: 'per-setter'
        })
      }
    }
    return errors
  }

  private static validateCrossField (_draft: Draft): BuilderError[] {
    return []
  }

  // ---- private helpers ----

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of CompleteSignatureBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- IBuilder<{ task: SignatureTask; result: SignatureResult }, void> surface ----

  setTask (task: SignatureTask): this {
    return new CompleteSignatureBuilder(this.engine, { ...this.draft, task }) as this
  }

  setResult (result: SignatureResult): this {
    return new CompleteSignatureBuilder(this.engine, { ...this.draft, result }) as this
  }

  build (): { task: SignatureTask; result: SignatureResult } {
    return this.toEngineInput()
  }

  toEngineInput (): { task: SignatureTask; result: SignatureResult } {
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
    return { task: this.draft.task!, result: this.draft.result! }
  }

  commit (): Promise<void> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(CompleteSignatureBuilder.KIND)
    }
    const input = this.toEngineInput()
    this.committed = true
    const result = this.engine.completeSignature(input.task, input.result)
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
    if (this.draft.result === undefined) {
      missing.push({ path: 'result', reason: 'required' })
    }
    return Object.freeze(missing)
  }

  update (partial: Partial<{ task: SignatureTask; result: SignatureResult }>): this {
    const merged: Draft = {
      task: partial.task ? { ...(this.draft.task ?? {} as SignatureTask), ...partial.task } : this.draft.task,
      result: partial.result ? { ...(this.draft.result ?? {} as SignatureResult), ...partial.result } : this.draft.result
    }
    return new CompleteSignatureBuilder(this.engine, merged) as this
  }

  reset (): this {
    return new CompleteSignatureBuilder(this.engine) as this
  }

  clone (): this {
    return new CompleteSignatureBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Draft> {
    return {
      kind: CompleteSignatureBuilder.KIND,
      version: CompleteSignatureBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {
    // Reserved no-op per CONTEXT.md
  }

  fromPayload (payload: { task: SignatureTask; result: SignatureResult }): this {
    return new CompleteSignatureBuilder(this.engine, {
      task: payload.task,
      result: payload.result
    }) as this
  }

  // ---- static methods ----

  static fromJSON (json: SerializedBuilder<unknown>, engine: ISignatureTasksEngine): CompleteSignatureBuilder {
    if (json.kind !== CompleteSignatureBuilder.KIND) {
      throw new Error(
        `CompleteSignatureBuilder.fromJSON: unknown kind "${json.kind}" (expected "${CompleteSignatureBuilder.KIND}")`
      )
    }
    if (json.version !== CompleteSignatureBuilder.KIND_VERSION) {
      throw new Error(
        `CompleteSignatureBuilder.fromJSON: unsupported version ${json.version} (expected ${CompleteSignatureBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error(
        'CompleteSignatureBuilder.fromJSON: draft must be a plain object'
      )
    }
    return new CompleteSignatureBuilder(engine, draft as Draft)
  }
}
