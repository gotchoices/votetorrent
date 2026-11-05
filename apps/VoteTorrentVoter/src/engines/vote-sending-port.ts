/**
 * vote-sending-port.ts — the joined network's strand, as the narrow `VoteSendingPort` the send flow
 * needs (spike 102, applied). Built by `EngineFactory` over the ALREADY-OPEN strand database, like
 * `strand-port-adapter.ts`: it imports no strand fabric and never closes the shared handle.
 *
 * The block commit goes through vote-engine's `commitPoolBlock` (one transaction: VoteBlock plus
 * every VoteBlockVoter row); the schema's CHECKs are the judge of the block, not this file.
 * `commitPoolBlock`'s result, including any `duplicateRegistrants` named after a duplicate-voter
 * failure, passes through untouched to the pool agent.
 */
import type {Database, SqlValue} from '@quereus/quereus';
import {commitPoolBlock} from '@votetorrent/vote-engine/rn';
import type {VoteSendingPort} from './vote-sending';

export const VOTE_SENDING_PORT_ENGINE = 'voteSendingPort';

async function first(db: Database, sql: string, params: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
	for await (const row of db.eval(sql, params as Record<string, SqlValue>)) {
		return row as Record<string, unknown>;
	}
	return undefined;
}

/** Quereus's canonical datetime (ISO, seconds, no zone), the form the `now` context compares. */
function canonicalDatetime(ms: number): string {
	return new Date(ms).toISOString().slice(0, 19);
}

export function createVoteSendingPort(db: Database): VoteSendingPort {
	return {
		async readElectionKey(electionId, revision) {
			const row = await first(db, 'select JointPublicKey from ElectionKey where ElectionId = :e and ElectionRevision = :r', {e: electionId, r: revision});
			const key = row?.JointPublicKey;
			return typeof key === 'string' && key.length > 0 ? key : null;
		},
		async readVotingClose(electionId, revision) {
			const row = await first(db, 'select Timeline from ElectionRevision where ElectionId = :e and Revision = :r', {e: electionId, r: revision});
			try {
				const closes = (JSON.parse(String(row?.Timeline)) as {accruingVotes?: unknown}).accruingVotes;
				return typeof closes === 'number' && Number.isFinite(closes) ? closes : null;
			} catch {
				return null;
			}
		},
		async commit(block, ballot, signatures, nowMs) {
			return await commitPoolBlock(db, block, ballot, signatures, {nowMs, now: canonicalDatetime(nowMs)});
		},
		async findRecordedVote(electionId, ballotId, registrantId) {
			const row = await first(db, 'select BlockCid from VoteBlockVoter where ElectionId = :e and BallotId = :b and RegistrantId = :reg', {e: electionId, b: ballotId, reg: registrantId});
			return typeof row?.BlockCid === 'string' ? row.BlockCid : null;
		},
	};
}
