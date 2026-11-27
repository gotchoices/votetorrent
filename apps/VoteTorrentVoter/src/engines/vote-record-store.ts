/**
 * vote-record-store.ts - binding over the shared vote record store
 * (`packages/workflows/src/voter/vote-record-store.ts`, phase 67 plan 30). The path stays so every
 * importer, the test mocks and the persistence gate's K1 exclusion keep working; this file supplies the
 * one platform seam, the device's AsyncStorage, as the store's key-value port. The marker, the guard and
 * the WR-02 write order live ONLY in the shared file; no workflow logic here.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import { createVoteRecordStore } from '@votetorrent/workflows/voter'
import type { SavedVoteRead, VoteGuardResult, VoteMarker, VoteMarkerClassification, VoteRecordEnvelope } from '@votetorrent/workflows/voter'

export {
	VOTE_MARKER_KEY_PREFIX,
	VOTE_RECORD_KEY_PREFIX,
	voteMarkerKey,
	voteRecordKey,
	VoteStoreWriteError,
	isVoteMarker,
	buildVoteMarker,
	voteRecordMatchesMarker,
	classifyVoteMarker,
	classifyVoteRecordEnvelope,
	deriveSavedVoteState,
} from '@votetorrent/workflows/voter'
export type {
	VoteMarker,
	VoteStoreWriteReason,
	VoteMarkerClassification,
	VoteEnvelopeClassification,
	SavedVoteState,
	SavedVoteRead,
	VoteGuardResult,
} from '@votetorrent/workflows/voter'

/** The app's store: the shared factory over the device's key-value store, built once per process. */
const appStore = createVoteRecordStore(AsyncStorage)

export function readVoteMarker(electionId: string): Promise<VoteMarkerClassification> {
	return appStore.readVoteMarker(electionId)
}

export function readSavedVote(electionId: string, currentRevision: number): Promise<SavedVoteRead> {
	return appStore.readSavedVote(electionId, currentRevision)
}

export function guard(electionId: string, currentRevision: number): Promise<VoteGuardResult> {
	return appStore.guard(electionId, currentRevision)
}

export function writeVoteRecord(envelope: VoteRecordEnvelope, marker: VoteMarker): Promise<void> {
	return appStore.writeVoteRecord(envelope, marker)
}
