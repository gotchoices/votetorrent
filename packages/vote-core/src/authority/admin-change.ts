import type { OfficerSelection, Scope } from './models.js'
import type { AcceptedOfficerInvitee } from '../invite/models.js'

/**
 * How long an administration change waits before it takes effect: five minutes.
 *
 * This is the only place the delay is declared. It has no setter and no switch of any kind: nothing
 * in the build, the environment or the bootstrap configuration can change it. Tests that need a
 * short wait pass a shorter delay as the second argument of `adminChangeEffectiveAt`.
 */
export const ADMIN_CHANGE_DELAY_MS = 300_000

/**
 * The moment a change made at `nowMs` takes effect, as the canonical 19-character UTC string
 * (`YYYY-MM-DDTHH:MM:SS`, no zone suffix) that the schema and the engine compare as text.
 */
export function adminChangeEffectiveAt (nowMs: number, delayMs: number = ADMIN_CHANGE_DELAY_MS): string {
  return new Date(nowMs + delayMs).toISOString().slice(0, 19)
}

/** Codes carried by the refusals of the administration-change flow. Apps route on `err.code` only. */
export const ADMIN_CHANGE_ERROR_CODES = Object.freeze({
  pending: 'admin-change-pending',
  noRadHolder: 'admin-no-rad-holder',
  inviteeNotAccepted: 'admin-invitee-not-accepted',
  cancelNotAuthorized: 'admin-cancel-not-authorized',
  cancelNotPending: 'admin-cancel-not-pending',
  cancelRefused: 'admin-cancel-refused'
} as const)

export type AdminChangeErrorCode = typeof ADMIN_CHANGE_ERROR_CODES[keyof typeof ADMIN_CHANGE_ERROR_CODES]

/**
 * Build the officer selection for someone who accepted an invitation. Always an `existing` selection
 * bound to the invitee's user id, never a name-matched `init` one. Refuses an invitee that has not
 * accepted (missing, or without a user id).
 */
export function officerSelectionFromInvitee (
  invitee: AcceptedOfficerInvitee | undefined,
  authorityId: string,
  title: string,
  scopes: Scope[]
): OfficerSelection {
  if (invitee === undefined || typeof invitee.userId !== 'string' || invitee.userId.length === 0) {
    throw Object.assign(new Error('The invitee has not accepted the invitation'), {
      code: ADMIN_CHANGE_ERROR_CODES.inviteeNotAccepted
    })
  }
  return { existing: { userId: invitee.userId, authorityId, title, scopes } }
}
