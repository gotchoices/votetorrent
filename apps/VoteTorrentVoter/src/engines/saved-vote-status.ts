/**
 * saved-vote-status.ts - the saved-vote read for Home and Timeline (Phase 63 plan 14).
 *
 * D-12: Home and Timeline reflect the vote saved on this phone.
 * D-19: the non-secret marker drives them with no fingerprint. This module never calls
 * `openVoteRecord`, never touches the keystore, and returns a state token only, never the envelope.
 * D-21: the current revision comes from `readReceiptElection`, the receipt's own source, so Home,
 * Timeline and the receipt agree.
 *
 * Fail closed: a marker whose record is missing or malformed reads as unreadable (the same mapping
 * as the 63-08 guard and the receipt's `loadVoteReceipt`).
 *
 * A vote whose every marker ballot is in the sent store (`vote-sent-store.ts`, read for the marker's
 * own revision, no fingerprint) reads as sent, so Home and Timeline agree with the ballot screen.
 * The marker is never rewritten: it stays saved-not-sent. Stale and unreadable keep priority.
 *
 * No cache: every call reads fresh, and callers re-read on focus. Storage is reached only through
 * the 63-08 store functions (gate K1). No logging.
 */

import type { ElectionReadDeps } from './election-read'
import { readReceiptElection, type ReceiptElection } from './vote-receipt'
import { readVoteSent } from './vote-sent-store'
import { readSavedVote, readVoteMarker, type SavedVoteRead } from './vote-record-store'

export type SavedVoteStatus =
	| { state: 'none' }
	| { state: 'unreadable' }
	| { state: 'sent' }
	| { state: 'saved' | 'stale'; revisionKnown: boolean }

export async function readSavedVoteStatus(
	deps: ElectionReadDeps,
	nowMs: number,
	electionId: string,
	readElection: (deps: ElectionReadDeps, nowMs: number, electionId: string) => Promise<ReceiptElection | null> = readReceiptElection,
): Promise<SavedVoteStatus> {
	if (typeof electionId !== 'string' || electionId.length === 0) {
		throw new TypeError('saved vote status electionId must be a non-empty string')
	}

	// Short-circuit: with no marker there is nothing to compare, so the engine is never read.
	const markerCls = await readVoteMarker(electionId)
	if (markerCls.kind === 'absent') return { state: 'none' }
	if (markerCls.kind === 'unreadable') return { state: 'unreadable' }

	let revision: number | null
	try {
		const election = await readElection(deps, nowMs, electionId)
		revision = election?.revision ?? null
	} catch {
		revision = null
	}

	const read: SavedVoteRead = await readSavedVote(electionId, revision ?? markerCls.marker.electionRevision)
	if (read.state === 'none') return { state: 'none' }
	if (read.state === 'unreadable') return { state: 'unreadable' }
	// A missing or malformed record is reported, never silently treated as a current vote.
	if (read.envelopeState !== 'ok') return { state: 'unreadable' }
	if (read.state === 'saved') {
		const { ballotIds, electionRevision } = markerCls.marker
		if (ballotIds.length > 0) {
			const sent = await readVoteSent(electionId, electionRevision)
			if (ballotIds.every((id) => Object.prototype.hasOwnProperty.call(sent, id))) return { state: 'sent' }
		}
	}
	return { state: read.state, revisionKnown: revision !== null }
}
