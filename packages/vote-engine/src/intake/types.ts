// src/intake/types.ts — Phase 62 Plan 14 (D-03, D-04, D-29, D-32, D-46)
//
// This module is the intake key-and-policy layer between 62-01's tables
// (`UserEncryptionKey`, `AuthorityIntakePolicy`) and 62-04's envelope/vault:
// officer encryption-key publication, D-04/D-32 recipient resolution, the
// D-03/D-04 sealer and opener, and the D-29/D-46 intake policy read/write.
//
// Invariant carried throughout: an opened plaintext never leaves process
// memory. Nothing in this module writes, caches or logs plaintext bytes, and
// `IntakeError`/`IntakeOpenResult` messages never carry a byte of it. This
// module does NOT widen T-62-01-10 — the pre-existing, open finding that
// `RegistrationEngine.submitRegistrationRequest` persists the (possibly
// still-plaintext) `Payload` on the replicated strand DB. That finding is
// referenced here only; fixing it needs a schema change
// (`RegistrationRequest.PayloadCidValid` binds `Payload` to the requester's
// own signed `PayloadCid`) and is tracked separately, pending a user decision.
//
// Every 62-04 name this module consumes (`EnvelopeBinding`, `EnvelopeRecipient`,
// `EnvelopeOpenFailureReason`, `IKeyVault`, `sealToRecipients`, `openEnvelope`,
// ...) is imported from `../crypto/index.js` and never redeclared here.

import type { Signature } from '@votetorrent/vote-core'
import type { EnvelopeBinding, EnvelopeOpenFailureReason, EnvelopeRecipient } from '../crypto/envelope-types.js'

/**
 * Every refusal this module can throw as an `IntakeError`. Messages built
 * from these codes never contain plaintext, key bytes or GSD phase numbers.
 */
export type IntakeErrorCode =
  | 'invalid-argument'
  | 'no-recipients'
  | 'too-many-recipients'
  | 'seal-failed'
  | 'not-a-current-officer'
  | 'not-authorized'
  | 'vault-error'
  | 'invalid-policy'
  | 'threshold-requires-co-sign'
  | 'policy-revision-conflict'

export class IntakeError extends Error {
  readonly code: IntakeErrorCode

  constructor (code: IntakeErrorCode, message: string) {
    super(message)
    this.name = 'IntakeError'
    this.code = code
    Object.setPrototypeOf(this, IntakeError.prototype)
  }
}

/**
 * Callback-only (never a pre-made `Signature`): every digest this module
 * signs is generated INSIDE the call from values not known beforehand (a
 * fresh `RegisteredAt`/`SetAt`, a fresh `Tid`), so a pre-made signature can
 * never match it.
 */
export type IntakeSignCallback = (digest: Uint8Array) => Promise<Signature>

export const REASSOCIATION_MODES = ['manual', 'automatic'] as const
export type ReassociationMode = (typeof REASSOCIATION_MODES)[number]
export const DEFAULT_REASSOCIATION_MODE: ReassociationMode = 'manual'
export const REST_BRIDGE_URL_MAX_LENGTH = 2048

/** Mirrors 62-01's `AssociationMatchMethod` view codes. */
export type ReassociationMatchMethod = 'code' | 'identity'
export type ReassociationRoute = 'manual' | 'automatic'

export interface IntakeRecipientDroppedKey {
  readonly userId: string
  readonly publicKey: string
  /** 'duplicate-public-key' is no longer produced (initial/G1 WR-03); kept so older readers type-check. */
  readonly reason: 'invalid-public-key' | 'signer-key-revoked' | 'duplicate-public-key'
}

/**
 * D-04/D-32: one entry per CURRENT officer of `authorityId` with a usable
 * key, sorted by userId ascending. `officersWithoutKey` lists current
 * officers with no usable key, also sorted.
 */
export interface IntakeRecipientSet {
  readonly authorityId: string
  readonly recipients: readonly EnvelopeRecipient[]
  readonly officersWithoutKey: readonly string[]
  readonly droppedKeys: readonly IntakeRecipientDroppedKey[]
  /** Keys published by more than one current officer; every claimant is still a recipient. Sorted. */
  readonly contestedKeys: ReadonlyArray<{ readonly publicKey: string, readonly userIds: readonly string[] }>
}

export interface OfficerEncryptionKeyRegistration {
  readonly userId: string
  readonly authorityId: string
  readonly publicKey: string
  readonly registeredAt: string
  /** 'renewed': the previous key was stranded by a signing-key replacement and a new generation was published (O-01). */
  readonly status: 'registered' | 'already-registered' | 'renewed'
  /** With 'already-registered': the officer's other device published a newer usable key, so this one is not current. */
  readonly superseded?: boolean
}

/** Closed outcome of `IntakeEngine.renewStrandedOfficerEncryptionKey` (O-01). */
export type OfficerKeyRenewalOutcome = 'not-an-officer' | 'no-local-key' | 'not-needed' | 'renewed'

/**
 * `published` = a `UserEncryptionKey` row exists for (userId, localPublicKey).
 * `isCurrent` = that row is the one recipient resolution picks for the user.
 * `isIntakeRecipient` = `isCurrent` AND the user is a current officer of
 * `authorityId`.
 */
export interface OfficerEncryptionKeyStatus {
  readonly userId: string
  readonly authorityId: string
  readonly hasLocalKey: boolean
  readonly localPublicKey: string | null
  readonly published: boolean
  readonly isCurrent: boolean
  readonly isIntakeRecipient: boolean
  /**
   * True when another CURRENT officer of this authority publishes this officer's current key.
   * The officer still receives every request.
   */
  readonly isContested: boolean
  /**
   * True only when the newest local key's published row was signed by a signing key that is no longer
   * a UserKey (`signer-key-revoked`). A contested, superseded or invalid key is never stranded (O-01).
   */
  readonly stranded: boolean
}

/** Resolves recipients on EVERY call, so officer changes replicated in between calls are honoured. */
export interface IntakeSealer {
  readonly authorityId: string
  seal (plaintext: string, binding: EnvelopeBinding): Promise<string>
}

export type IntakeOpenFailureReason = EnvelopeOpenFailureReason | 'no-local-key' | 'vault-error'

export type IntakeOpenResult =
  | { readonly ok: true, readonly plaintext: string }
  | { readonly ok: false, readonly reason: IntakeOpenFailureReason, readonly detail: string }

/** NEVER throws. */
export interface IntakeOpener {
  readonly userId: string
  open (sealed: string, binding: EnvelopeBinding): Promise<IntakeOpenResult>
}

/** No row for an authority reads as revision 0 / no bridge / 'manual' / isDefault true (D-46). */
export interface AuthorityIntakePolicyView {
  readonly authorityId: string
  readonly revision: number
  readonly restBridgeUrl: string | null
  readonly reassociationMode: ReassociationMode
  readonly setAt: string | null
  readonly isDefault: boolean
}

/** An omitted field keeps the current (or default) value. A present `expectedRevision` must equal the current revision. */
export interface AuthorityIntakePolicyInput {
  readonly authorityId: string
  readonly restBridgeUrl?: string | null
  readonly reassociationMode?: ReassociationMode
  readonly expectedRevision?: number
}
