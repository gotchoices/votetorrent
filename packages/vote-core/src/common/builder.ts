/**
 * IBuilder contract, helper types, and error classes for the v1.1 builder
 * pattern (Phase 07 — FOUND-01, FOUND-02).
 *
 * The builder layer is additive: direct engine methods remain callable;
 * `commit()` delegates 1:1 to the existing direct method.
 */

/** Structured validation error produced by per-setter or cross-field validators. */
export interface BuilderError {
  path: string
  code: string
  message: string
  kind: 'per-setter' | 'cross-field'
}

/** A required field that has not yet been set on the builder draft. */
export interface MissingField {
  path: string
  reason: string
}

/** JSON-serializable envelope for builder draft persistence. */
export interface SerializedBuilder<TDraft> {
  kind: string
  version: number
  draft: TDraft
}

/**
 * Generic builder contract for progressively-validated, serializable
 * engine payloads. Every mutating engine method has a corresponding
 * builder that implements this interface with concrete TInput / TOutput.
 */
export interface IBuilder<TInput, TOutput> {
  /** Validates and returns the engine payload synchronously. */
  build(): TInput
  /** Validates and returns the engine payload synchronously. */
  toEngineInput(): TInput
  /** Validates, delegates to the engine method, and returns the result. */
  commit(): Promise<TOutput>
  /** Runs per-setter AND cross-field validators against the current draft. */
  isValid(): boolean
  /** Returns all accumulated validation errors. */
  errors(): readonly BuilderError[]
  /** Returns all required fields not yet set on the draft. */
  missingFields(): readonly MissingField[]
  /** Returns a fresh builder with the given partial applied to the draft. */
  update(partial: Partial<TInput>): this
  /** Returns a fresh builder with an empty draft and cleared committed flag. */
  reset(): this
  /** Returns a fresh builder with the current draft and cleared committed flag. */
  clone(): this
  /** Returns a JSON-serializable envelope of the current draft. */
  toJSON(): SerializedBuilder<unknown>
  /** Reserved no-op (future-proof for v1.2+ resource ownership). */
  dispose(): void
}

/** Thrown when `build()`, `toEngineInput()`, or `commit()` is called on an invalid draft. */
export class BuilderValidationError extends Error {
  readonly errors: readonly BuilderError[]

  constructor (errors: readonly BuilderError[]) {
    super(`Builder validation failed (${errors.length} error(s))`)
    this.name = 'BuilderValidationError'
    this.errors = errors
  }
}

/** Thrown when `commit()` is called a second time on the same builder instance. */
export class BuilderAlreadyCommittedError extends Error {
  readonly kind: string

  constructor (kind: string) {
    super(`Builder "${kind}" already committed — clone() to retry`)
    this.name = 'BuilderAlreadyCommittedError'
    this.kind = kind
  }
}
