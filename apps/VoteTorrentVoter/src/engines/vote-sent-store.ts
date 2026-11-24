/**
 * vote-sent-store.ts — binding over the shared sent-ballot store
 * (`packages/workflows/src/voter/vote-sent-store.ts`, phase 67 plan 30). The path stays so every importer
 * keeps working; this file supplies the platform seams: the device's AsyncStorage as the key-value port and
 * `vtDebug`/`idPrefix` as the debug sink. The chained read-modify-write lives ONLY in the shared file.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {createVoteSentStore} from '@votetorrent/workflows/voter';
import {idPrefix, vtDebug} from './vt-debug';

export {VOTE_SENT_KEY_PREFIX, voteSentKey} from '@votetorrent/workflows/voter';
export type {VoteSentState} from '@votetorrent/workflows/voter';

/** One instance per process: the per-election write chain is this instance's, as the module map was. */
const appSentStore = createVoteSentStore(AsyncStorage, {vtDebug: (t, e, d) => vtDebug(t, e, d), idPrefix: (id) => idPrefix(id)});

/** The sent ballots for this election revision; an unreadable or older-revision record reads as none sent. */
export function readVoteSent(electionId: string, electionRevision: number): Promise<Record<string, string>> {
	return appSentStore.readVoteSent(electionId, electionRevision);
}

/** Add one sent ballot (chained per election; a failed read skips the write and rejects, IN-05). */
export function recordVoteSent(electionId: string, electionRevision: number, ballotId: string, cid: string): Promise<void> {
	return appSentStore.recordVoteSent(electionId, electionRevision, ballotId, cid);
}
