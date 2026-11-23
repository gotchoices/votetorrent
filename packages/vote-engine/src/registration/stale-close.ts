// src/registration/stale-close.ts — the read behind closing a stale registration request.
//
// Above a 'vrg' threshold of 1 a request whose co-signers never act would stay pending forever and
// the requester would never be told. Once the request's session has been open for
// REGISTRATION_STALE_CLOSE_TIMEOUT_MS, any single 'vrg' officer may close it as rejected
// (RegistrationEngine.closeStaleRegistrationRequest). This module only READS; it writes nothing.
//
// The session's opening time is the later of the requester's signed SubmittedAt and the authority's
// ReceivedAt. AdminSigning carries no time column, and ReceivedAt is inside no digest, so taking the
// later of the two keeps an officer from moving the clock earlier than the moment the requester signed.
//
// Enforcement is tier 2 (this engine): the schema's RegistrationRequest.DecisionValid accepts any
// reached 'vrg' session over the decision digest, and RegistrationDecision needs one current 'vrg'
// officer's signature, so neither CHECK knows about the timeout.

import type { Database } from '@quereus/quereus'
import { REGISTRATION_STALE_CLOSE_TIMEOUT_MS } from '@votetorrent/vote-core'
import type { RegistrationStaleCloseAvailability } from '@votetorrent/vote-core'
import { readAuthorityThreshold } from '../signing/threshold.js'
import { reZuluDatetime } from '../signing/ceremony-helpers.js'
import { asText } from '../utils.js'

export interface StaleCloseFacts {
  readonly authorityId: string
  readonly status: string
  /** The request's review session (its registrant Tasks' nonce) has an AdminSignature. */
  readonly sessionReached: boolean
  readonly availability: RegistrationStaleCloseAvailability
}

function instantOf (value: unknown, column: string): number {
  const ms = Date.parse(reZuluDatetime(asText(value, column)))
  if (!Number.isFinite(ms)) throw new Error(`readStaleCloseFacts: ${column} is not a datetime`)
  return ms
}

/** `undefined` when no such request exists. */
export async function readStaleCloseFacts (db: Database, requestId: string, nowMs: number): Promise<StaleCloseFacts | undefined> {
  const row = await db
    .prepare('select AuthorityId, Status, SubmittedAt, ReceivedAt from RegistrationRequest where Id = :requestId')
    .get({ requestId })
  if (!row) return undefined
  const authorityId = asText(row.AuthorityId, 'RegistrationRequest.AuthorityId')
  const status = asText(row.Status, 'RegistrationRequest.Status')
  const openedAtMs = Math.max(
    instantOf(row.SubmittedAt, 'RegistrationRequest.SubmittedAt'),
    instantOf(row.ReceivedAt, 'RegistrationRequest.ReceivedAt')
  )
  const availableAtMs = openedAtMs + REGISTRATION_STALE_CLOSE_TIMEOUT_MS

  const threshold = await readAuthorityThreshold(db, authorityId, 'vrg')
  const reachedRow = await db
    .prepare(
      `select 1 as x
         from RegistrantSignatureTaskExtension E
         join Task T on T.Id = E.TaskId
         join AdminSignature S on S.SigningNonce = T.SigningNonce
        where E.RequestId = :requestId
        limit 1`
    )
    .get({ requestId })
  const sessionReached = reachedRow != null

  return {
    authorityId,
    status,
    sessionReached,
    availability: {
      requestId,
      threshold,
      openedAt: new Date(openedAtMs).toISOString(),
      availableAt: new Date(availableAtMs).toISOString(),
      available: status === 'p' && threshold > 1 && !sessionReached && nowMs >= availableAtMs
    }
  }
}
