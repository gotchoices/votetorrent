/**
 * Thrown when a method is not yet available in the current phase.
 * The {@link gatingPhase} property names the phase in which the feature
 * will be implemented, e.g. "connectDevice — available in Phase 22 (P2P fabric)".
 *
 * This is the shared foundation for ENG-07: it lets the grep guard
 * (Plan 03) distinguish sanctioned phase-gated deferrals from forgotten
 * `Not implemented` stubs.
 *
 * Modelled after {@link BuilderValidationError} in builder.ts.
 */
export class FeatureNotAvailableError extends Error {
  readonly gatingPhase: string

  constructor (message: string) {
    super(message)
    this.name = 'FeatureNotAvailableError'
    this.gatingPhase = message
  }
}
