import type {
	BallotDetails,
	BallotInit,
	ElectionDetails,
	ElectionRevisionInit,
	KeyholderInvite,
	BallotSummary,
	IElectionEngine,
} from '@votetorrent/vote-core/';

export class ElectionEngine implements IElectionEngine {
	getBallotDetails(id: string): Promise<BallotDetails> {
		throw new Error('Not implemented');
	}

	getBallots(): Promise<BallotSummary[]> {
		throw new Error('Not implemented');
	}

	getElectionDetails(): Promise<ElectionDetails> {
		throw new Error('Not implemented yet');
	}

	inviteKeyholder(
		keyholder: KeyholderInvite,
		electionId: string
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
		keyholder: KeyholderInvite,
		electionId: string
	): Promise<void> {
		throw new Error('Not implemented');
	}
}
