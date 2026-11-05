/**
 * vote-record-store.ts - local vote persistence (Phase 63 plan 08; D-19, D-20, D-21, D-29).
 *
 * Two AsyncStorage keys per election:
 *   - the MARKER is plaintext and non-secret (six fields). It drives Home, Timeline and the guard
 *     without a fingerprint (D-19, D-12).
 *   - the RECORD key holds ONLY the 63-07 envelope ciphertext (D-29). This module never sees
 *     plaintext choices, never imports the seal/open functions, and never touches the keystore.
 *
 * Write order is record first, marker second. The marker is the commit point. The batch write
 * API is deliberately not used, because its atomicity on Android is ASSUMED (RESEARCH A5).
 *
 * WR-02: because the record is overwritten before the marker, a failed marker write can leave a
 * record the marker does not describe (on the D-21 stale path: the old marker over the new
 * record). Such a record is UNCOMMITTED. Two rules keep marker and record from disagreeing:
 *   - a marker write that rejects is read back. Only if the stored marker is exactly the new one
 *     (the write landed and then reported failure) is the save reported as committed; otherwise
 *     it fails `storage-failed`, matching what is stored;
 *   - any reader that decrypts the record must check it with `voteRecordMatchesMarker` against the
 *     stored marker and treat a mismatch as unreadable, never reveal it (`revealVoteReceipt`).
 * No rollback write is made: the store has exactly two writes (the 63-08 persistence gate), and
 * the next Submit overwrites the uncommitted record because the guard reads only the marker.
 *
 * Fail closed: an unreadable marker or record never re-enables Submit, and nothing is ever
 * deleted, regenerated or reconciled (the device-user D-42 precedent).
 *
 * D-20: the guard is a convenience, not enforcement. Clearing app data defeats it (spike 099
 * finding 3); one-vote-per-registrant is enforced by block validation in the network phase.
 *
 * D-21: a marker whose revision differs from the election's current revision is stale. The next
 * Submit replaces both keys by overwriting them, never by deleting.
 *
 * No logging: the only diagnostic surface is `VoteStoreWriteError.reason`.
 *
 * Any other module that needs these keys goes through this file; the persistence gate in
 * `src/__tests__/vote-record-persistence.gate.test.ts` enforces that.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import { isVoteRecord, isVoteRecordEnvelope, type VoteRecord, type VoteRecordEnvelope } from './vote-record-vault'

export const VOTE_MARKER_KEY_PREFIX = 'votetorrent.voteMarker.'
export const VOTE_RECORD_KEY_PREFIX = 'votetorrent.voteRecord.'

function assertElectionId(electionId: string): void {
	if (typeof electionId !== 'string' || electionId.length === 0) {
		throw new TypeError('vote store electionId must be a non-empty string')
	}
}

function assertRevision(revision: number): void {
	if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
		throw new TypeError('vote store revision must be a non-negative integer')
	}
}

export function voteMarkerKey(electionId: string): string {
	assertElectionId(electionId)
	return VOTE_MARKER_KEY_PREFIX + electionId
}

export function voteRecordKey(electionId: string): string {
	assertElectionId(electionId)
	return VOTE_RECORD_KEY_PREFIX + electionId
}

export interface VoteMarker {
	v: 1
	electionId: string
	electionRevision: number
	ballotIds: string[]
	savedAt: string
	status: 'saved-not-sent'
}

export type VoteStoreWriteReason = 'already-saved' | 'unreadable' | 'invalid-input' | 'storage-failed'

export class VoteStoreWriteError extends Error {
	readonly reason: VoteStoreWriteReason

	constructor(reason: VoteStoreWriteReason) {
		super('vote record store write failed (' + reason + ')')
		this.name = 'VoteStoreWriteError'
		this.reason = reason
	}
}

const MARKER_KEYS = ['v', 'electionId', 'electionRevision', 'ballotIds', 'savedAt', 'status'] as const

export function isVoteMarker(value: unknown): value is VoteMarker {
	try {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
		const o = value as Record<string, unknown>
		if (Object.keys(o).length !== MARKER_KEYS.length) return false
		for (const k of MARKER_KEYS) if (!(k in o)) return false
		if (o.v !== 1) return false
		if (typeof o.electionId !== 'string' || o.electionId.length === 0) return false
		if (typeof o.electionRevision !== 'number' || !Number.isInteger(o.electionRevision) || o.electionRevision < 0) return false
		if (!Array.isArray(o.ballotIds) || o.ballotIds.length === 0) return false
		if (!(o.ballotIds as unknown[]).every((b) => typeof b === 'string' && b.length > 0)) return false
		if (typeof o.savedAt !== 'string' || o.savedAt.length === 0) return false
		return o.status === 'saved-not-sent'
	} catch {
		return false
	}
}

export function buildVoteMarker(record: VoteRecord): VoteMarker {
	if (!isVoteRecord(record)) throw new VoteStoreWriteError('invalid-input')
	return {
		v: 1,
		electionId: record.electionId,
		electionRevision: record.electionRevision,
		ballotIds: record.voter.ballots.map((b) => b.ballotId),
		savedAt: record.savedAt,
		status: 'saved-not-sent',
	}
}

function sameMarker(a: VoteMarker, b: VoteMarker): boolean {
	return (
		a.v === b.v &&
		a.electionId === b.electionId &&
		a.electionRevision === b.electionRevision &&
		a.savedAt === b.savedAt &&
		a.status === b.status &&
		a.ballotIds.length === b.ballotIds.length &&
		a.ballotIds.every((id, i) => id === b.ballotIds[i])
	)
}

/**
 * WR-02: whether a decrypted record is the one `marker` commits: same election, revision, save
 * time and ballot ids, the exact fields `buildVoteMarker` derives. False for an invalid record or
 * marker; never throws.
 */
export function voteRecordMatchesMarker(record: VoteRecord, marker: VoteMarker): boolean {
	try {
		if (!isVoteRecord(record) || !isVoteMarker(marker)) return false
		return sameMarker(buildVoteMarker(record), marker)
	} catch {
		return false
	}
}

export type VoteMarkerClassification = { kind: 'absent' } | { kind: 'ok'; marker: VoteMarker } | { kind: 'unreadable' }
export type VoteEnvelopeClassification = { kind: 'absent' } | { kind: 'ok'; envelope: VoteRecordEnvelope } | { kind: 'unreadable' }

export function classifyVoteMarker(raw: string | null, electionId: string): VoteMarkerClassification {
	try {
		if (raw === null) return { kind: 'absent' }
		const parsed: unknown = JSON.parse(raw)
		if (!isVoteMarker(parsed) || parsed.electionId !== electionId) return { kind: 'unreadable' }
		return { kind: 'ok', marker: parsed }
	} catch {
		return { kind: 'unreadable' }
	}
}

export function classifyVoteRecordEnvelope(raw: string | null): VoteEnvelopeClassification {
	try {
		if (raw === null) return { kind: 'absent' }
		const parsed: unknown = JSON.parse(raw)
		if (!isVoteRecordEnvelope(parsed)) return { kind: 'unreadable' }
		return { kind: 'ok', envelope: parsed }
	} catch {
		return { kind: 'unreadable' }
	}
}

export type SavedVoteState = 'none' | 'saved' | 'stale' | 'unreadable'

export function deriveSavedVoteState(marker: VoteMarkerClassification, currentRevision: number): SavedVoteState {
	if (marker.kind === 'absent') return 'none'
	if (marker.kind === 'unreadable') return 'unreadable'
	return marker.marker.electionRevision === currentRevision ? 'saved' : 'stale'
}

const READ_FAILED: unique symbol = Symbol('vote-store-read-failed')

async function safeGetItem(key: string): Promise<string | null | typeof READ_FAILED> {
	try {
		return await AsyncStorage.getItem(key)
	} catch {
		return READ_FAILED
	}
}

function markerFrom(raw: string | null | typeof READ_FAILED, electionId: string): VoteMarkerClassification {
	return raw === READ_FAILED ? { kind: 'unreadable' } : classifyVoteMarker(raw, electionId)
}

export async function readVoteMarker(electionId: string): Promise<VoteMarkerClassification> {
	assertElectionId(electionId)
	return markerFrom(await safeGetItem(voteMarkerKey(electionId)), electionId)
}

export interface SavedVoteRead {
	state: SavedVoteState
	marker: VoteMarker | null
	envelope: VoteRecordEnvelope | null
	envelopeState: 'absent' | 'ok' | 'unreadable'
}

export async function readSavedVote(electionId: string, currentRevision: number): Promise<SavedVoteRead> {
	assertElectionId(electionId)
	assertRevision(currentRevision)
	const [rawMarker, rawRecord] = await Promise.all([safeGetItem(voteMarkerKey(electionId)), safeGetItem(voteRecordKey(electionId))])
	const markerClass = markerFrom(rawMarker, electionId)
	const envClass: VoteEnvelopeClassification = rawRecord === READ_FAILED ? { kind: 'unreadable' } : classifyVoteRecordEnvelope(rawRecord)
	return {
		state: deriveSavedVoteState(markerClass, currentRevision),
		marker: markerClass.kind === 'ok' ? markerClass.marker : null,
		envelope: envClass.kind === 'ok' ? envClass.envelope : null,
		envelopeState: envClass.kind,
	}
}

export type VoteGuardResult = 'ok' | 'already-saved' | 'stale'

export async function guard(electionId: string, currentRevision: number): Promise<VoteGuardResult> {
	assertElectionId(electionId)
	assertRevision(currentRevision)
	const state = deriveSavedVoteState(await readVoteMarker(electionId), currentRevision)
	if (state === 'none') return 'ok'
	if (state === 'stale') return 'stale'
	// 'saved' and 'unreadable' both block Submit: an unreadable marker never re-enables it (D-20).
	return 'already-saved'
}

export async function writeVoteRecord(envelope: VoteRecordEnvelope, marker: VoteMarker): Promise<void> {
	if (!isVoteRecordEnvelope(envelope) || !isVoteMarker(marker)) throw new VoteStoreWriteError('invalid-input')
	const state = deriveSavedVoteState(await readVoteMarker(marker.electionId), marker.electionRevision)
	if (state === 'saved') throw new VoteStoreWriteError('already-saved')
	if (state === 'unreadable') throw new VoteStoreWriteError('unreadable')
	// 'none' and 'stale' proceed: a stale vote is replaced by overwrite (D-21).
	try {
		await AsyncStorage.setItem(voteRecordKey(marker.electionId), JSON.stringify(envelope))
	} catch {
		throw new VoteStoreWriteError('storage-failed')
	}
	try {
		await AsyncStorage.setItem(voteMarkerKey(marker.electionId), JSON.stringify(marker))
	} catch {
		// WR-02: report what is stored. The save committed only if the new marker is what reads back.
		const stored = await readVoteMarker(marker.electionId)
		if (stored.kind === 'ok' && sameMarker(stored.marker, marker)) return
		throw new VoteStoreWriteError('storage-failed')
	}
}
