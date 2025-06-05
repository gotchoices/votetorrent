import type {
	BallotDetails,
	BallotInit,
	ElectionDetails,
	ElectionRevisionInit,
	KeyholderInvitationContent,
} from '@votetorrent/vote-core/dist/src/election/models';
import type { SID } from '@votetorrent/vote-core/dist/src/common';
import type { BallotSummary } from '@votetorrent/vote-core/dist/src/election/models';
import type { IElectionEngine } from '@votetorrent/vote-core/dist/src/election/types';

export class ElectionEngine implements IElectionEngine {
	getBallotDetails(sid: SID): Promise<BallotDetails> {
		throw new Error('Not implemented');
	}

	getBallots(): Promise<BallotSummary[]> {
		throw new Error('Not implemented');
	}

	getElectionDetails(): Promise<ElectionDetails> {
		throw new Error('Not implemented yet');
	}

	inviteKeyholder(
		keyholder: KeyholderInvitationContent,
		electionSid: SID
	): Promise<void> {
		throw new Error('Not implemented');
	}

	proposeBallot(ballot: BallotInit): Promise<void> {
		throw new Error('Not implemented');
	}

	proposeRevision(revision: ElectionRevisionInit): Promise<void> {
		throw new Error('Not implemented');
	}

	revokeKeyholder(
		keyholder: KeyholderInvitationContent,
		electionSid: SID
	): Promise<void> {
		throw new Error('Not implemented');
	}
}
