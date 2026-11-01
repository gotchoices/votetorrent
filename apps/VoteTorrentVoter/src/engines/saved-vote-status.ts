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

/**
 * The local half of the read, for a line already on screen (UAT 65 gap 2, WR-03). It reads only the
 * marker and the sent store (no engine read), so a screen coming back from a send can show the new
 * line at once while the full read, which waits on the strand, is still on its way:
 * - a line shown as saved whose every marker ballot is now in the sent store reads sent;
 * - a line shown as none (or nothing shown yet, the usual path vote -> Submit -> Send -> Done -> Home)
 *   reads sent when the marker exists and every marker ballot is in the sent store, and otherwise saved
 *   with the revision not yet checked (this read never looks at the election), so Vote now hides.
 * Sent is never returned unless every marker ballot is in the sent store, read for the marker's own
 * revision. The full read keeps the last word, so stale and unreadable still win when it lands.
 * Anything else (a stale, unreadable or sent line, no marker, a corrupt marker, no ballot ids, any
 * failure) is null: keep what is shown.
 */
export async function readSentSinceShown(
	electionId: string,
	shown: SavedVoteStatus | undefined,
): Promise<{ state: 'sent' } | { state: 'saved'; revisionKnown: false } | null> {
	const from = shown?.state ?? 'none'
	if (from !== 'saved' && from !== 'none') return null
	try {
		const markerCls = await readVoteMarker(electionId)
		if (markerCls.kind === 'absent' || markerCls.kind === 'unreadable') return null
		const { ballotIds, electionRevision } = markerCls.marker
		if (ballotIds.length === 0) return null
		const sent = await readVoteSent(electionId, electionRevision)
		if (ballotIds.every((id) => Object.prototype.hasOwnProperty.call(sent, id))) return { state: 'sent' }
		return from === 'none' ? { state: 'saved', revisionKnown: false } : null
	} catch {
		return null
	}
}
