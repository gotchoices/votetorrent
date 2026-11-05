/**
 * vote-sent-store.ts — which ballots of a saved vote have reached the network, and in which block.
 *
 * Non-secret: a ballot id and a block cid say nothing about the choices (the block's voter list is
 * public on the strand once it commits). Kept apart from the vote marker so a sent vote never
 * rewrites the record the receipt reads. The strand stays the authority: `sendSavedVote` asks the
 * replicated VoteBlockVoter rows before it pools a ballot, so a lost write here can never cause a
 * second vote.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {vtDebug} from './vt-debug';

export const VOTE_SENT_KEY_PREFIX = 'votetorrent.voteSent.';

export interface VoteSentState {
	electionRevision: number
	/** ballotId -> VoteBlock.Cid */
	ballots: Record<string, string>
}

export function voteSentKey(electionId: string): string {
	return `${VOTE_SENT_KEY_PREFIX}${electionId}`;
}

function isSentState(value: unknown): value is VoteSentState {
	const v = value as VoteSentState;
	return v !== null && typeof v === 'object' && Number.isInteger(v.electionRevision) && v.ballots !== null && typeof v.ballots === 'object'
		&& Object.values(v.ballots).every(cid => typeof cid === 'string' && cid.length > 0);
}

/** A stored value as the sent ballots for this revision: absent, malformed or another revision is none sent. */
function parseSent(raw: string | null, electionRevision: number): Record<string, string> {
	if (raw === null) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		return isSentState(parsed) && parsed.electionRevision === electionRevision ? {...parsed.ballots} : {};
	} catch {
		return {};
	}
}

/** The sent ballots for this election revision; an unreadable or older-revision record reads as none sent. */
export async function readVoteSent(electionId: string, electionRevision: number): Promise<Record<string, string>> {
	try {
		return parseSent(await AsyncStorage.getItem(voteSentKey(electionId)), electionRevision);
	} catch {
		return {};
	}
}

/** the last write per election key: writes to one key run one after another */
const writeChains = new Map<string, Promise<void>>();

/**
 * Add one sent ballot. A read-modify-write, so writes to one election are chained: sending pools every
 * ballot in parallel, and two ballots that land together used to read the same old state, so the
 * second write dropped the first ballot and Home kept "not sent" while the ballot screen said Sent.
 *
 * IN-05: a storage READ that fails (AsyncStorage throws) is not an empty store: the write is skipped
 * and the call rejects with that error, so earlier sent ballots are never overwritten by this one
 * alone. An absent, malformed or older-revision value is replaced as before. The strand stays the
 * authority, so a skipped write costs at most a "not sent" line until the next send re-checks it.
 */
export async function recordVoteSent(electionId: string, electionRevision: number, ballotId: string, cid: string): Promise<void> {
	const key = voteSentKey(electionId);
	const write = async (): Promise<void> => {
		let raw: string | null;
		try {
			raw = await AsyncStorage.getItem(key);
		} catch (err) {
			// debug only (silent unless the __DEV__ switch is on): the error class, never its text
			vtDebug('sent-store', 'record-skipped-read-failed', {class: err instanceof Error ? err.name : typeof err});
			throw err;
		}
		const ballots = parseSent(raw, electionRevision);
		ballots[ballotId] = cid;
		const state: VoteSentState = {electionRevision, ballots};
		await AsyncStorage.setItem(key, JSON.stringify(state));
	};
	const next = (writeChains.get(key) ?? Promise.resolve()).then(write, write);
	const tail = next.catch(() => undefined);
	writeChains.set(key, tail);
	try {
		await next;
	} finally {
		if (writeChains.get(key) === tail) writeChains.delete(key);
	}
}
