/**
 * Typed error for the R2/D-04/D-05 registration idempotency guard (Phase 57
 * Plan 02). Mirrors `BuilderAlreadyCommittedError`'s shape verbatim: explicit
 * `readonly` identifying field, explicit `this.name`, and a message that
 * states the recovery — never a raw SQL constraint string.
 */

/**
 * Thrown by `RegistrationEngine.register()` / `createRegistrant()`, and by
 * `SignatureTasksEngine`'s registrant-approval pre-check/finalize guards, when
 * the given `registrantId` already has a `Registrant` row. Registration is a
 * multi-step ceremony (biometric, attestation, association) — the caller must
 * RESUME the ceremony for the existing id, never delete/rotate the existing
 * row and retry, which risks destroying key-bound state.
 *
 * `requestId` is OPTIONAL — the engine-level guard (`register()`/
 * `createRegistrant()`) has no `RegistrationRequest` in scope and omits it;
 * the approval-side guard (`SignatureTasksEngine.resolveAcceptableRegistrant
 * Approval`) does have one and names it, so a caller can tell WHICH pending
 * request was refused. This is still exactly one message shape produced by
 * exactly one class — not two independently-worded errors for the same root
 * condition.
 */
export class RegistrantAlreadyExistsError extends Error {
  readonly registrantId: string
  readonly requestId?: string

  constructor (registrantId: string, requestId?: string) {
    const requestSuffix = requestId ? ` (refused while deciding RegistrationRequest ${requestId})` : ''
    super(`Registrant "${registrantId}" already exists — resume the registration ceremony for this id instead of re-registering it${requestSuffix}`)
    this.name = 'RegistrantAlreadyExistsError'
    this.registrantId = registrantId
    this.requestId = requestId
  }
}

/**
 * D-44: the typed refusal every duplicate-detection and duplicate-closure guard throws (Phase 62
 * Plan 19). Mirrors `RegistrantAlreadyExistsError`'s shape: explicit `readonly` identifying
 * fields and an explicit `this.name`. Every caller builds `message` from ids and codes ONLY —
 * never a name, a date of birth, an email, a phone value, payload text, or a GSD phase number —
 * so this error class can never become a T-62-01-10 leak surface of its own.
 */
export type RegistrationDuplicateErrorCode =
  | 'request-not-found'
  | 'request-not-decided'
  | 'authority-mismatch'
  | 'self-closure'
  | 'not-a-likely-duplicate'
  | 'closed-as-duplicate'
  | 'transaction-open'
  | 'publisher-db-mismatch'

export class RegistrationDuplicateError extends Error {
  readonly code: RegistrationDuplicateErrorCode
  readonly requestId: string
  readonly otherRequestId?: string

  constructor (code: RegistrationDuplicateErrorCode, requestId: string, message: string, otherRequestId?: string) {
    super(message)
    this.name = 'RegistrationDuplicateError'
    this.code = code
    this.requestId = requestId
    this.otherRequestId = otherRequestId
  }
}

/**
 * D-49 (Phase 62 Plan 31): every `RegistrationContentAccess` value except the two READABLE ones.
 * `RegistrationContentAccess` itself lives in `registration/models.ts` (not re-imported here, to
 * avoid a cross-file type-only import loop in this barrel-exported module) — this type is
 * structurally identical to `Exclude<RegistrationContentAccess, 'opened' | 'unsealed'>`.
 */
export type RegistrationContentAccessFailure =
  'no-opener' | 'not-a-recipient' | 'unreadable' | 'tampered'

/**
 * Thrown by `SignatureTasksEngine`'s registrant approval gate (`completeSignature`'s accept path,
 * via `resolveAcceptableRegistrantApproval`) when the request's payload cannot be opened on this
 * device or fails the PayloadCid recheck (D-49). Thrown BEFORE any signature is spent or any row
 * is written. The message carries the request id and the access code only — never payload text,
 * key bytes or a GSD phase number.
 */
export class RegistrationContentAccessError extends Error {
  readonly code: 'registration-content-unreadable'
  readonly access: RegistrationContentAccessFailure
  readonly requestId: string

  constructor (access: RegistrationContentAccessFailure, requestId: string) {
    super(`RegistrationRequest ${requestId} cannot be approved on this device (access=${access})`)
    this.name = 'RegistrationContentAccessError'
    this.code = 'registration-content-unreadable'
    this.access = access
    this.requestId = requestId
  }
}

/**
 * Thrown by the decision paths (reject / approve of a RegistrationRequest, challenge and terminal
 * transitions of an AssociationRequest) when the requester's signature does not verify against ANY
 * raw ISO-Z spelling of the stored SubmittedAt, so the row could never be written by a decision.
 * Raised BEFORE any officer signature is requested or spent (UAT 62 gap 2). The message carries
 * the table and request id only.
 */
export class RequesterSignatureUnverifiableError extends Error {
  readonly code: 'requester-signature-unverifiable'
  readonly table: 'RegistrationRequest' | 'AssociationRequest'
  readonly requestId: string

  constructor (table: 'RegistrationRequest' | 'AssociationRequest', requestId: string) {
    super(`${table} ${requestId}: the requester's signature does not verify against any form of its stored SubmittedAt, so it cannot be decided`)
    this.name = 'RequesterSignatureUnverifiableError'
    this.code = 'requester-signature-unverifiable'
    this.table = table
    this.requestId = requestId
  }
}
