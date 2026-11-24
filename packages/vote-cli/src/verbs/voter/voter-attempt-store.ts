// The CLI voter's RegistrationCeremonyAttemptStore (67-11's seam) over the daemon's file kv, plus the
// small last-attempt record `read-decision` needs after the ceremony has cleared the attempt. A platform
// implementation like FileKeyVault, not a workflow: the record shape and the stored key are the Voter
// app's (`apps/VoteTorrentVoter/src/engines/registration-attempt-store.ts`, pinned by
// test/voter-mirror-drift.spec.ts), so a record written by either side reads back on the other.
//
// None of the three store calls ever throws (the seam contract): a kv or parse failure reads as "no
// attempt" or is swallowed, and nothing is logged. The record holds ids, the authority, the election,
// the two PUBLIC keys and the association init; never the registrant payload, a code or a nonce.

import type { AssociationRequestInit } from '@votetorrent/vote-core'
import type { RegistrationCeremonyAttemptRecord, RegistrationCeremonyAttemptStore } from '@votetorrent/workflows/voter'

/** The Voter app's own key, so the record is the same record on both sides. */
export const VOTER_ATTEMPT_KV_KEY = 'votetorrent.registrationAttempt.v1'
/** The CLI-only last-attempt record (ids and a key tag; it survives the attempt store's `clear`). */
export const VOTER_LAST_ATTEMPT_KV_KEY = 'vt.voter.last-attempt.v1'

/** The slice of the daemon's FileKvStorage the stores use (the shared KvStorage shape). */
export interface VoterKv {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

function isAssociationInit(v: unknown): v is AssociationRequestInit {
  const a = v as AssociationRequestInit
  return (
    a !== null &&
    typeof a === 'object' &&
    isNonEmptyString(a.id) &&
    isNonEmptyString(a.authorityId) &&
    isNonEmptyString(a.registrantId) &&
    isNonEmptyString(a.deviceKey) &&
    (a.electionId === undefined || isNonEmptyString(a.electionId)) &&
    isNonEmptyString(a.submittedAt)
  )
}

function isRecord(v: unknown): v is RegistrationCeremonyAttemptRecord {
  const r = v as RegistrationCeremonyAttemptRecord
  return (
    r !== null &&
    typeof r === 'object' &&
    r.version === 1 &&
    isNonEmptyString(r.identityKey) &&
    isNonEmptyString(r.authorityId) &&
    isNonEmptyString(r.electionId) &&
    isNonEmptyString(r.registrantId) &&
    isNonEmptyString(r.registrationSubmittedAt) &&
    typeof r.registrationStaged === 'boolean' &&
    isNonEmptyString(r.deviceKey) &&
    (r.association === null ||
      (isAssociationInit(r.association) &&
        r.association.registrantId === r.registrantId &&
        r.association.deviceKey === r.deviceKey &&
        r.association.authorityId === r.authorityId))
  )
}

/** Only the fields a resume needs, so nothing else ever reaches the store. */
function stripRecord(r: RegistrationCeremonyAttemptRecord): RegistrationCeremonyAttemptRecord {
  const a = r.association
  return {
    version: 1,
    identityKey: r.identityKey,
    authorityId: r.authorityId,
    electionId: r.electionId,
    registrantId: r.registrantId,
    registrationSubmittedAt: r.registrationSubmittedAt,
    registrationStaged: r.registrationStaged,
    deviceKey: r.deviceKey,
    association:
      a === null
        ? null
        : {
            id: a.id,
            authorityId: a.authorityId,
            registrantId: a.registrantId,
            deviceKey: a.deviceKey,
            ...(a.electionId === undefined ? {} : { electionId: a.electionId }),
            submittedAt: a.submittedAt
          }
  }
}

/** The 67-11 attempt store over the daemon kv. `read` is null for anything that is not a v1 record. */
export function createVoterAttemptStore(kv: VoterKv): RegistrationCeremonyAttemptStore {
  return {
    async read() {
      try {
        const raw = await kv.getItem(VOTER_ATTEMPT_KV_KEY)
        if (raw === null) return null
        const parsed: unknown = JSON.parse(raw)
        return isRecord(parsed) ? stripRecord(parsed) : null
      } catch {
        return null
      }
    },
    async write(record) {
      try {
        await kv.setItem(VOTER_ATTEMPT_KV_KEY, JSON.stringify(stripRecord(record)))
      } catch {
        // a failed write only loses the resume
      }
    },
    async clear() {
      try {
        await kv.removeItem(VOTER_ATTEMPT_KV_KEY)
      } catch {
        // nothing to clear, or the kv refused: the next read decides
      }
    }
  }
}

/**
 * What `read-decision` needs once the attempt store is cleared: the two request ids, the authority and
 * election they belong to, a TAG of the P-256 key (never the key) and the last milestone token. No
 * init, no key, no code, no registrant field.
 */
export interface VoterLastAttemptRecord {
  registrantId: string
  associationRequestId: string | null
  authorityId: string
  electionId: string
  deviceKeyTag: string | null
  milestone: string
}

export interface VoterLastAttemptStore {
  read(): Promise<VoterLastAttemptRecord | null>
  write(record: VoterLastAttemptRecord): Promise<void>
}

const MILESTONE_RE = /^[a-z-]{1,40}$/

function isLastAttempt(v: unknown): v is VoterLastAttemptRecord {
  const r = v as VoterLastAttemptRecord
  return (
    r !== null &&
    typeof r === 'object' &&
    isNonEmptyString(r.registrantId) &&
    (r.associationRequestId === null || isNonEmptyString(r.associationRequestId)) &&
    isNonEmptyString(r.authorityId) &&
    isNonEmptyString(r.electionId) &&
    (r.deviceKeyTag === null || isNonEmptyString(r.deviceKeyTag)) &&
    typeof r.milestone === 'string' &&
    MILESTONE_RE.test(r.milestone)
  )
}

function stripLastAttempt(r: VoterLastAttemptRecord): VoterLastAttemptRecord {
  return {
    registrantId: r.registrantId,
    associationRequestId: r.associationRequestId,
    authorityId: r.authorityId,
    electionId: r.electionId,
    deviceKeyTag: r.deviceKeyTag,
    milestone: r.milestone
  }
}

/** The last-attempt record over the daemon kv; same never-throw rule as the attempt store. */
export function createLastAttemptStore(kv: VoterKv): VoterLastAttemptStore {
  return {
    async read() {
      try {
        const raw = await kv.getItem(VOTER_LAST_ATTEMPT_KV_KEY)
        if (raw === null) return null
        const parsed: unknown = JSON.parse(raw)
        return isLastAttempt(parsed) ? stripLastAttempt(parsed) : null
      } catch {
        return null
      }
    },
    async write(record) {
      try {
        await kv.setItem(VOTER_LAST_ATTEMPT_KV_KEY, JSON.stringify(stripLastAttempt(record)))
      } catch {
        // a failed write only loses the read-decision ids
      }
    }
  }
}
